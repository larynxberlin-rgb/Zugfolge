import { createHash } from "node:crypto";

import { compareUtf8 } from "./utf8.js";

export type PenaltyFocus = "punctuality" | "cancellation" | "seats" | "connections";
export type RequirementFocus = "capacity" | "comfort" | "bicycle" | "accessibility";

export interface ScoringWeights { readonly price: number; readonly quality: number }
export type SpecialCondition =
  | { readonly type: "additional-stop"; readonly minimumAdditionalStops: number }
  | { readonly type: "maximum-age"; readonly maximumAgeYears: number }
  | { readonly type: "traction"; readonly allowed: readonly ("electric" | "diesel" | "battery" | "hydrogen")[] }
  | { readonly type: "replacement-plan" };
export interface TenderProfile {
  readonly id: string;
  readonly weights: ScoringWeights;
  readonly requirementFocus: RequirementFocus;
  readonly penaltyFocus: PenaltyFocus;
  readonly specialCondition?: SpecialCondition;
  readonly viabilitySurchargeBasisPoints: number;
}

export interface EconomyRates {
  readonly trackPerTrainKmCents: bigint;
  readonly stationPerStopCents: bigint;
  readonly facilityPerHourCents: bigint;
  readonly energyPerKwhCents: bigint;
  readonly personnelPerHourCents: bigint;
  readonly administrationPerPeriodCents: bigint;
  readonly vehiclePerPeriodCents: bigint;
  readonly overnightStablingPerPeriodCents: bigint;
  readonly protectionEquipmentPerPeriodCents: bigint;
  readonly lateInterestBasisPoints: number;
}
export interface EconomyRules {
  readonly qualityBaselinePunctualityBasisPoints: number;
  readonly pointsPerExtraSeat: number;
  readonly pointsPerPunctualityBasisPoint: number;
  readonly pointsPerAdditionalStop: number;
  readonly requirementFocusMaximumPoints: number;
  readonly contractBonusCentsPerPeriod: bigint;
  readonly penaltyRates: Readonly<Record<PenaltyFocus, bigint>>;
  readonly penaltyFocusMultiplierBasisPoints: number;
  readonly publicOperationSurchargeBasisPoints: number;
  readonly failedPackageFeeStepBasisPoints: number;
  readonly failedPackageReductionStepBasisPoints: number;
}

export interface EconomyRelease {
  readonly schema: "economy-release/v1";
  readonly version: string;
  readonly rates: EconomyRates;
  readonly rules: EconomyRules;
  readonly tenderProfiles: readonly TenderProfile[];
  readonly fareInspection?: FareInspectionEconomyV1;
  readonly checksum: string;
}

/** Vollständiger gehashter M15-Vertrag; fachliche Berechnung und Validierung erfolgen in Rust. */
export interface FareInspectionEconomyV1 {
  readonly schemaVersion: "fare-inspection-economy/v1";
  readonly minimumClaimCents: bigint; readonly ordinaryFareMultiplier: number; readonly reducedClaimCents: bigint;
  readonly proofWindowDays: number; readonly dayLengthMs: number; readonly handlingCostCents: bigint;
  readonly proofHandlingCostCents: bigint; readonly policeHandlingCostCents: bigint;
  readonly fullPaymentBasisPoints: number; readonly partialPaymentBasisPoints: number;
  readonly partialPaymentShareBasisPoints: number; readonly paymentDelayMs: number; readonly writeOffDelayMs: number;
  readonly validProofSubmissionBasisPoints: number; readonly validProofDelayMs: number;
  readonly premiumMultiplierBasisPoints: number; readonly positiveDailyCapBasisPoints: number;
  readonly revenueAllocation: "uniform_settled_service_interval/v1";
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => compareUtf8(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function buildEconomyRelease(input: Omit<EconomyRelease, "schema" | "checksum">): EconomyRelease {
  if (input.version.trim() === "" || input.tenderProfiles.length < 2) throw new Error("Release braucht Version und mindestens zwei Vergabeprofile.");
  const ids = new Set<string>();
  for (const profile of input.tenderProfiles) {
    if (ids.has(profile.id) || profile.weights.price < 0 || profile.weights.quality < 0 || profile.weights.price + profile.weights.quality !== 10_000 || profile.viabilitySurchargeBasisPoints < 0) throw new Error("Ungültiger Vergabeprofil-Katalog.");
    ids.add(profile.id);
    const special = profile.specialCondition;
    if (special?.type === "additional-stop" && (!Number.isInteger(special.minimumAdditionalStops) || special.minimumAdditionalStops < 1)) throw new Error("Zusatzhalt-Auflage braucht eine positive Mindestzahl.");
    if (special?.type === "maximum-age" && (!Number.isInteger(special.maximumAgeYears) || special.maximumAgeYears < 0)) throw new Error("Fahrzeugalter-Auflage ist ungültig.");
    if (special?.type === "traction" && special.allowed.length === 0) throw new Error("Traktionsauflage braucht mindestens eine Antriebsart.");
  }
  for (const rate of Object.values(input.rates)) if (typeof rate === "bigint" ? rate < 0n : rate < 0) throw new Error("Kostensätze dürfen nicht negativ sein.");
  for (const rule of [...Object.values(input.rules).flatMap((value) => typeof value === "object" ? Object.values(value) : [value])]) if (typeof rule === "bigint" ? rule < 0n : rule < 0) throw new Error("Wirtschaftsregeln dürfen nicht negativ sein.");
  const body = { schema: "economy-release/v1" as const, version: input.version, rates: input.rates, rules: input.rules, tenderProfiles: [...input.tenderProfiles].sort((a, b) => compareUtf8(a.id, b.id)),
    ...(input.fareInspection === undefined ? {} : { fareInspection: input.fareInspection }) };
  return Object.freeze({ ...body, checksum: createHash("sha256").update(canonical(body)).digest("hex") });
}

export interface WorldEconomyPin { readonly worldId: string; readonly releaseVersion: string; readonly releaseChecksum: string }
export function pinEconomyRelease(worldId: string, release: EconomyRelease): WorldEconomyPin {
  return Object.freeze({ worldId, releaseVersion: release.version, releaseChecksum: release.checksum });
}
export function assertPinnedRelease(pin: WorldEconomyPin, release: EconomyRelease): void {
  if (pin.releaseVersion !== release.version || pin.releaseChecksum !== release.checksum) throw new Error("EconomyRelease stimmt nicht mit der Welt-Pinnung überein.");
}
