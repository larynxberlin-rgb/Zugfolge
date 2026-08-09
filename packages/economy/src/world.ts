import { createHash } from "node:crypto";

export interface WorldProfile {
  readonly durationMonths: 6 | 12 | 18 | "unlimited";
  readonly periodWeeks: 3 | 5 | 7 | 8;
  readonly contractPeriods: number;
  readonly tenderLeadPeriods: 1;
  readonly totalPeriods?: number;
}

export function deriveWorldProfile(durationMonths: WorldProfile["durationMonths"]): WorldProfile {
  if (durationMonths === "unlimited") return Object.freeze({ durationMonths, periodWeeks: 8, contractPeriods: 4, tenderLeadPeriods: 1 });
  const values = durationMonths === 6 ? [3, 2, 8] : durationMonths === 12 ? [5, 3, 10] : [7, 3, 11];
  return Object.freeze({ durationMonths, periodWeeks: values[0] as 3 | 5 | 7, contractPeriods: values[1]!, tenderLeadPeriods: 1, totalPeriods: values[2] });
}

export interface Lot { readonly id: string; readonly size: number; readonly attractiveness: number }
export interface TenderCalendarEntry { readonly lotId: string; readonly announcementPeriod: number; readonly tenderPeriod: number; readonly initialOperator: "public" }

function rank(seed: bigint, stream: "tender_release" | "tender_profile", key: string): string {
  return createHash("sha256").update(`zugfolge/${stream}/v1\0${seed.toString()}\0${key}`).digest("hex");
}

/** Geschichtete, seed-deterministische Permutation über gleichmäßige Fenster. */
export function createTenderCalendar(profile: WorldProfile, lots: readonly Lot[], worldSeed: bigint): readonly TenderCalendarEntry[] {
  if (lots.length === 0) throw new Error("Vergabekalender braucht Lose.");
  const half = profile.totalPeriods === undefined ? Math.max(4, profile.contractPeriods * 2) : Math.floor(profile.totalPeriods / 2);
  const windows = Math.min(half, lots.length);
  const sorted = [...lots].sort((a, b) => b.size + b.attractiveness - (a.size + a.attractiveness) || a.id.localeCompare(b.id));
  const buckets = Array.from({ length: windows }, () => [] as Lot[]);
  sorted.forEach((lot, index) => buckets[index % windows]!.push(lot));
  const entries = buckets.flatMap((bucket, window) => bucket.sort((a, b) => rank(worldSeed, "tender_release", a.id).localeCompare(rank(worldSeed, "tender_release", b.id))).map((lot) => ({ lotId: lot.id, announcementPeriod: window, tenderPeriod: window + profile.tenderLeadPeriods, initialOperator: "public" as const })));
  const earliestRepeat = Math.min(...entries.map((entry) => entry.tenderPeriod + profile.contractPeriods));
  const latestInitial = Math.max(...entries.map((entry) => entry.tenderPeriod));
  if (earliestRepeat > latestInitial) throw new Error("Weltentwurf überlappt Erst- und Wiedervergabe nicht.");
  return Object.freeze(entries.sort((a, b) => a.tenderPeriod - b.tenderPeriod || a.lotId.localeCompare(b.lotId)));
}

export function deterministicProfileOrder<T extends { readonly id: string }>(profiles: readonly T[], worldSeed: bigint): readonly T[] {
  return [...profiles].sort((a, b) => rank(worldSeed, "tender_profile", a.id).localeCompare(rank(worldSeed, "tender_profile", b.id)));
}
