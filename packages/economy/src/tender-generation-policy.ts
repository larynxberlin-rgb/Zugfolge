import type { GtfsPlanningEnvelope } from "@zugfolge/gtfs";

import { assertNonnegativeI64 } from "./money.js";
import type { EconomyRelease } from "./release.js";
import { deriveGtfsServiceSpecifications } from "./service-planning.js";
import { calculateViabilityThreshold } from "./tender.js";
import { deriveWorldProfile, type WorldProfile } from "./world.js";

export const TENDER_GENERATION_SCHEMA = "zugfolge-tender-generation/v1" as const;

/** Fachvertrag: specifications/tender-generation-v1.json. */
export const TENDER_GENERATION_TIMING = Object.freeze({
  smallLotBidWindowSeconds: 86_400,
  regularLotBidWindowSeconds: 3 * 86_400,
  failedOperationRetenderPeriods: 2,
  maximumCatchUpRoundsPerCycle: 64,
});

export interface TenderGenerationPolicy {
  readonly schemaVersion: typeof TENDER_GENERATION_SCHEMA;
  readonly authorityId: string;
  readonly authorityBudgetCentsPerPeriod: bigint;
  readonly failurePenaltyCents: bigint;
}

export function validateTenderGenerationPolicy(policy: TenderGenerationPolicy): void {
  if (policy.schemaVersion !== TENDER_GENERATION_SCHEMA || typeof policy.authorityId !== "string" || policy.authorityId.trim() === "") {
    throw new Error("Automatische Ausschreibungen brauchen eine versionierte Aufgabentraegerregel.");
  }
  if (typeof policy.authorityBudgetCentsPerPeriod !== "bigint" || typeof policy.failurePenaltyCents !== "bigint") throw new Error("Vergabebudget und Mobilisierungspoenale brauchen Integer-Cent.");
  assertNonnegativeI64(policy.authorityBudgetCentsPerPeriod, "Aufgabentraegerbudget je Periode");
  assertNonnegativeI64(policy.failurePenaltyCents, "Mobilisierungspoenale");
  if (policy.authorityBudgetCentsPerPeriod === 0n) throw new Error("Automatische Ausschreibungen brauchen ein positives Aufgabentraegerbudget.");
}

/** Konservative Obergrenze: alle Lose einer Periode, teuerstes freigegebenes Profil. */
export function deriveTenderAuthorityBudgetCents(
  planning: GtfsPlanningEnvelope,
  worldId: string,
  release: EconomyRelease,
  durationMonths: WorldProfile["durationMonths"],
): bigint {
  const profile = deriveWorldProfile(durationMonths);
  let budget = 0n;
  for (const { specification } of deriveGtfsServiceSpecifications(planning, worldId, profile.periodWeeks * 7 * 86_400).values()) {
    const threshold = release.tenderProfiles.reduce((maximum, candidate) => {
      const amount = calculateViabilityThreshold(release, specification, candidate);
      return amount > maximum ? amount : maximum;
    }, 0n);
    const perPeriod = threshold * specification.trainKmPerPeriod;
    const contractCost = perPeriod * BigInt(profile.contractPeriods);
    const publicBase = perPeriod * BigInt(TENDER_GENERATION_TIMING.failedOperationRetenderPeriods);
    const publicCost = publicBase + publicBase * BigInt(release.rules.publicOperationSurchargeBasisPoints) / 10_000n;
    budget += contractCost > publicCost ? contractCost : publicCost;
    assertNonnegativeI64(budget, "Abgeleitetes Aufgabentraegerbudget");
  }
  return budget;
}
