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

const MASK_64 = 0xffff_ffff_ffff_ffffn;
const GAMMA = 0x9e37_79b9_7f4a_7c15n;
const MIX_1 = 0xbf58_476d_1ce4_e5b9n;
const MIX_2 = 0x94d0_49bb_1331_11ebn;

export type EconomySubstream = "tender_release" | "tender_profile";

/** Bytegenaue TypeScript-Umsetzung von `zugfolge-determinism::WorldSeed`. */
export function canonicalSubstreamState(
  worldSeed: bigint,
  period: number,
  stream: EconomySubstream,
): bigint {
  if (worldSeed < 0n || worldSeed > MASK_64) throw new RangeError("Weltseed liegt außerhalb u64.");
  if (!Number.isSafeInteger(period) || period < 0 || period > 0xffff_ffff) throw new RangeError("Periode liegt außerhalb u32.");
  const domain = Buffer.from("zugfolge/substream/v1", "utf8");
  const world = Buffer.alloc(8);
  world.writeBigUInt64BE(worldSeed);
  const periodBytes = Buffer.alloc(4);
  periodBytes.writeUInt32BE(period);
  const name = Buffer.from(stream, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(name.length));
  return createHash("sha256")
    .update(domain)
    .update(world)
    .update(periodBytes)
    .update(length)
    .update(name)
    .digest()
    .readBigUInt64BE(0);
}

class CanonicalRng {
  #state: bigint;

  constructor(state: bigint) {
    this.#state = state;
  }

  nextU64(): bigint {
    this.#state = (this.#state + GAMMA) & MASK_64;
    let value = this.#state;
    value = ((value ^ (value >> 30n)) * MIX_1) & MASK_64;
    value = ((value ^ (value >> 27n)) * MIX_2) & MASK_64;
    return (value ^ (value >> 31n)) & MASK_64;
  }

  below(bound: bigint): bigint {
    if (bound <= 0n || bound > MASK_64) throw new RangeError("Zufallsgrenze liegt außerhalb u64.");
    let product = this.nextU64() * bound;
    let low = product & MASK_64;
    if (low < bound) {
      const threshold = ((-bound) & MASK_64) % bound;
      while (low < threshold) {
        product = this.nextU64() * bound;
        low = product & MASK_64;
      }
    }
    return product >> 64n;
  }

  shuffle<T>(items: T[]): void {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const other = Number(this.below(BigInt(index + 1)));
      [items[index], items[other]] = [items[other]!, items[index]!];
    }
  }
}

/** Erster Wert eines kanonischen Stroms; nützlich für Release-Golden-Vektoren. */
export function canonicalSubstreamFirstU64(
  worldSeed: bigint,
  period: number,
  stream: EconomySubstream,
): bigint {
  return new CanonicalRng(canonicalSubstreamState(worldSeed, period, stream)).nextU64();
}

/** Geschichtete, seed-deterministische Permutation über gleichmäßige Fenster. */
export function createTenderCalendar(
  profile: WorldProfile,
  lots: readonly Lot[],
  worldSeed: bigint,
  period = 0,
): readonly TenderCalendarEntry[] {
  if (lots.length === 0) throw new Error("Vergabekalender braucht Lose.");
  const half = profile.totalPeriods === undefined ? Math.max(4, profile.contractPeriods * 2) : Math.floor(profile.totalPeriods / 2);
  const windows = Math.min(half, lots.length);
  const sorted = [...lots].sort((a, b) => b.size + b.attractiveness - (a.size + a.attractiveness) || a.id.localeCompare(b.id));
  const buckets = Array.from({ length: windows }, () => [] as Lot[]);
  sorted.forEach((lot, index) => buckets[index % windows]!.push(lot));
  const rng = new CanonicalRng(canonicalSubstreamState(worldSeed, period, "tender_release"));
  const entries = buckets.flatMap((bucket, window) => {
    bucket.sort((a, b) => a.id.localeCompare(b.id));
    rng.shuffle(bucket);
    return bucket.map((lot) => ({ lotId: lot.id, announcementPeriod: window, tenderPeriod: window + profile.tenderLeadPeriods, initialOperator: "public" as const }));
  });
  const earliestRepeat = Math.min(...entries.map((entry) => entry.tenderPeriod + profile.contractPeriods));
  const latestInitial = Math.max(...entries.map((entry) => entry.tenderPeriod));
  if (earliestRepeat > latestInitial) throw new Error("Weltentwurf überlappt Erst- und Wiedervergabe nicht.");
  return Object.freeze(entries.sort((a, b) => a.tenderPeriod - b.tenderPeriod || a.lotId.localeCompare(b.lotId)));
}

export function deterministicProfileOrder<T extends { readonly id: string }>(
  profiles: readonly T[],
  worldSeed: bigint,
  period = 0,
): readonly T[] {
  const ordered = [...profiles].sort((a, b) => a.id.localeCompare(b.id));
  const rng = new CanonicalRng(canonicalSubstreamState(worldSeed, period, "tender_profile"));
  rng.shuffle(ordered);
  return ordered;
}
