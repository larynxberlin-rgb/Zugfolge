import { createHash } from "node:crypto";

export type PenaltyFocus = "punctuality" | "cancellation" | "seats" | "connections";
export type RequirementFocus = "capacity" | "comfort" | "bicycle" | "accessibility";

export interface ScoringWeights { readonly price: number; readonly quality: number }
export interface TenderProfile {
  readonly id: string;
  readonly weights: ScoringWeights;
  readonly requirementFocus: RequirementFocus;
  readonly penaltyFocus: PenaltyFocus;
  readonly specialCondition?: "additional-stop" | "maximum-age" | "traction" | "replacement-plan";
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

export interface EconomyRelease {
  readonly schema: "economy-release/v1";
  readonly version: string;
  readonly rates: EconomyRates;
  readonly tenderProfiles: readonly TenderProfile[];
  readonly checksum: string;
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function buildEconomyRelease(input: Omit<EconomyRelease, "schema" | "checksum">): EconomyRelease {
  if (input.version.trim() === "" || input.tenderProfiles.length < 2) throw new Error("Release braucht Version und mindestens zwei Vergabeprofile.");
  const ids = new Set<string>();
  for (const profile of input.tenderProfiles) {
    if (ids.has(profile.id) || profile.weights.price < 0 || profile.weights.quality < 0 || profile.weights.price + profile.weights.quality !== 10_000 || profile.viabilitySurchargeBasisPoints < 0) throw new Error("Ungültiger Vergabeprofil-Katalog.");
    ids.add(profile.id);
  }
  for (const rate of Object.values(input.rates)) if (typeof rate === "bigint" ? rate < 0n : rate < 0) throw new Error("Kostensätze dürfen nicht negativ sein.");
  const body = { schema: "economy-release/v1" as const, version: input.version, rates: input.rates, tenderProfiles: [...input.tenderProfiles].sort((a, b) => a.id.localeCompare(b.id)) };
  return Object.freeze({ ...body, checksum: createHash("sha256").update(canonical(body)).digest("hex") });
}

export interface WorldEconomyPin { readonly worldId: string; readonly releaseVersion: string; readonly releaseChecksum: string }
export function pinEconomyRelease(worldId: string, release: EconomyRelease): WorldEconomyPin {
  return Object.freeze({ worldId, releaseVersion: release.version, releaseChecksum: release.checksum });
}
export function assertPinnedRelease(pin: WorldEconomyPin, release: EconomyRelease): void {
  if (pin.releaseVersion !== release.version || pin.releaseChecksum !== release.checksum) throw new Error("EconomyRelease stimmt nicht mit der Welt-Pinnung überein.");
}
