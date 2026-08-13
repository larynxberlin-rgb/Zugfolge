import { describe, expect, it } from "vitest";
import {
  accrueCreditInterest, advancePublicOperation, assistBid, awardTender, buildEconomyRelease, calculateProfitAndLoss, classifyPosting,
  canonicalSubstreamFirstU64, canonicalSubstreamState, commitAuthorityBudget, createTender, createTenderCalendar, deriveWorldProfile,
  evaluateInsolvency, improveFailedPackage, performOperatingTransition, scoreBid,
  repayCredit, settleContract, startPublicOperation, updatePrequalification, validateVehicle,
  type Bid, type EconomyRelease, type ServiceSpecification, type Tender,
} from "./index.js";

const release: EconomyRelease = buildEconomyRelease({
  version: "lhe-2026.1",
  rates: { trackPerTrainKmCents: 500n, stationPerStopCents: 1_000n, facilityPerHourCents: 2_000n, energyPerKwhCents: 30n, personnelPerHourCents: 3_000n, administrationPerPeriodCents: 50_000n, vehiclePerPeriodCents: 100_000n, overnightStablingPerPeriodCents: 20_000n, protectionEquipmentPerPeriodCents: 10_000n, lateInterestBasisPoints: 500 },
  rules: { qualityBaselinePunctualityBasisPoints: 8_500, pointsPerExtraSeat: 40, pointsPerPunctualityBasisPoint: 1, pointsPerAdditionalStop: 300, requirementFocusMaximumPoints: 1_500, contractBonusCentsPerPeriod: 100_000n, penaltyRates: { punctuality: 10n, cancellation: 10_000n, seats: 100n, connections: 1_000n }, penaltyFocusMultiplierBasisPoints: 20_000, publicOperationSurchargeBasisPoints: 2_000, failedPackageFeeStepBasisPoints: 500, failedPackageReductionStepBasisPoints: 400 },
  tenderProfiles: [
    { id: "price", weights: { price: 7_000, quality: 3_000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 1_000 },
    { id: "quality", weights: { price: 3_000, quality: 7_000 }, requirementFocus: "accessibility", penaltyFocus: "connections", specialCondition: { type: "replacement-plan" }, viabilitySurchargeBasisPoints: 1_500 },
  ],
});
const spec: ServiceSpecification = { lines: ["RE 1"], trainKmPerPeriod: 10_000n, stopsPerPeriod: 500n, serviceHoursPerPeriod: 1_000n, facilityHoursPerPeriod: 100n, energyKwhPerPeriod: 50_000n, vehicleCount: 5n, overnightUnits: 5n, protectionUnits: 5n, requirements: { minimumSeats: 200, firstClassBasisPoints: 500, accessible: true, bicyclePlaces: 12, wheelchairPlaces: 2, requiredEquipment: ["wifi"] } };
const tender: Tender = createTender({ id: "t1", worldId: "w1", lotId: "lot-a", incumbentOperatorId: "public", profile: release.tenderProfiles[0]!, specification: spec, announcedAt: 0, opensAt: 86_400, closesAt: 4 * 86_400, operatingFrom: 21 * 86_400, contractPeriods: 2, periodDurationSeconds: 21 * 86_400, release, smallLot: false });
const vehicle = {
  formationId: "f1",
  minimumSeats: 220,
  firstClassBasisPoints: 600,
  accessible: true,
  bicyclePlaces: 15,
  wheelchairPlaces: 2,
  requiredEquipment: ["wifi"],
  vehicleAgeYears: 5,
  maximumSpeedKph: 160,
  operatingCostCentsPerTrainKm: 700,
  traction: "electric" as const,
  replacementPlan: true,
  evidence: { source: "zugfolge-fleet-mobilization/v1" as const, fleetRevision: 7, snapshotHash: "a".repeat(64), formationId: "f1" },
};

describe("M6 vollständig", () => {
  it("friert Release ein und leitet alle Weltprofile ab", () => {
    expect(release.checksum).toHaveLength(64);
    expect(deriveWorldProfile(6)).toMatchObject({ periodWeeks: 3, contractPeriods: 2, totalPeriods: 8 });
    expect(deriveWorldProfile(12).periodWeeks).toBe(5);
    expect(deriveWorldProfile(18).periodWeeks).toBe(7);
    expect(deriveWorldProfile("unlimited").periodWeeks).toBe(8);
  });

  it("veröffentlicht einen reproduzierbaren, geschichteten Vergabekalender", () => {
    const lots = Array.from({ length: 8 }, (_, i) => ({ id: `lot-${i}`, size: 100 - i * 7, attractiveness: i * 3 }));
    const a = createTenderCalendar(deriveWorldProfile(6), lots, 42n);
    const b = createTenderCalendar(deriveWorldProfile(6), [...lots].reverse(), 42n);
    expect(a).toEqual(b);
    expect(new Set(a.map((entry) => entry.lotId)).size).toBe(8);
    expect(a.every((entry) => entry.initialOperator === "public")).toBe(true);
    expect(canonicalSubstreamState(42n, 0, "tender_release")).toBe(465_896_281_649_676_834n);
    expect(canonicalSubstreamFirstU64(42n, 0, "tender_release")).toBe(15_648_887_706_766_360_790n);
    expect(canonicalSubstreamFirstU64(42n, 0, "tender_profile")).toBe(2_062_826_105_575_757_761n);
  });

  it("prüft Fahrzeugkonfiguration, zeigt Wertung, assistiert und schlägt sofort zu", () => {
    expect(validateVehicle(spec.requirements, vehicle)).toEqual([]);
    const base: Omit<Bid, "orderingFeeCentsPerTrainKm"> = { id: "b1", operatorId: "op1", vehicle, promises: { extraSeats: 20, punctualityBasisPoints: 9_600, additionalStops: 1 }, submittedAt: tender.closesAt - 1 };
    const assisted = assistBid(tender, { ...base, expectedCostCentsPerTrainKm: tender.viabilityThresholdCentsPerTrainKm * 9n / 10n, targetMarginBasisPoints: 500 });
    expect(assisted.preview).toEqual(scoreBid(tender, assisted));
    const award = awardTender(tender, [assisted], tender.closesAt);
    expect(award.winner?.operatorId).toBe("op1");
    expect(award.scores.get("b1")?.dimensions).toHaveProperty("punctuality");
  });

  it("wertet den Profilfokus aus und deckelt ihn an der Release-Grenze", () => {
    const base: Bid = {
      id: "focus-base",
      operatorId: "op1",
      orderingFeeCentsPerTrainKm: tender.viabilityThresholdCentsPerTrainKm,
      vehicle: { ...vehicle, minimumSeats: spec.requirements.minimumSeats },
      promises: { extraSeats: 0, punctualityBasisPoints: 8_500, additionalStops: 0 },
      submittedAt: tender.closesAt,
    };
    const focused = scoreBid(tender, { ...base, id: "focus-better", vehicle: { ...vehicle, minimumSeats: 10_000 } });
    const baseline = scoreBid(tender, base);
    expect(focused.dimensions.requirementFocus).toBe(release.rules.requirementFocusMaximumPoints);
    expect(focused.qualityPoints).toBeGreaterThan(baseline.qualityPoints);
  });

  it("führt Mobilisierung, Vertrag, Eigenbetrieb, Nachbesserung und Budget aus", () => {
    expect(performOperatingTransition({ incumbentOperatorId: "old", winnerOperatorId: "new", proof: { source: "m5-release", verifiedBy: "zugfolge-fleet-mobilization/v1", fleetRevision: 7, snapshotHash: "a".repeat(64), formationIds: [], personnelDutyIds: ["duty-1"], pathReservationIds: ["path-1"] }, at: 10, timetableBoundary: 10, failurePenaltyCents: 99n })).toMatchObject({ operatorId: "public", penaltyCents: 99n });
    const settlement = settleContract({ id: "c", worldId: "w1", lotId: "l", operatorId: "op", startsAt: 0, endsAt: 2, orderingFeeCentsPerTrainKm: 1_000n, bonusCentsPerPeriod: 5_000n, penaltyRates: { punctuality: 2n, cancellation: 500n, seats: 10n, connections: 100n }, evidenceRequired: ["operations"] }, { trainKm: 100n, punctualityBasisPoints: 8_800, cancellations: 1, missingSeats: 2, missedConnections: 1, evidence: ["operations"] });
    expect(settlement.netCents).toBe(98_980n);
    expect(() => settleContract({ id: "c", worldId: "w1", lotId: "l", operatorId: "op", startsAt: 0, endsAt: 2, orderingFeeCentsPerTrainKm: 1_000n, bonusCentsPerPeriod: 5_000n, penaltyRates: { punctuality: 2n, cancellation: 500n, seats: 10n, connections: 100n }, evidenceRequired: [] }, { trainKm: -1n, punctualityBasisPoints: 8_800, cancellations: 0, missingSeats: 0, missedConnections: 0, evidence: [] })).toThrow(RangeError);
    const publicOperation = startPublicOperation("l", ["pool-1"]);
    expect(improveFailedPackage(publicOperation, 2, release.rules)).toMatchObject({ suppliedVehicles: true, retenderAfterPeriods: 2 });
    expect(advancePublicOperation({ ...publicOperation, periodsRemaining: 1 }, 2, release.rules).retender).toBeDefined();
    expect(commitAuthorityBudget({ authorityId: "a", period: 1, availableCents: 1_000n, committedCents: 200n }, 700n).committedCents).toBe(900n);
  });

  it("erklärt Ergebnis und telegrafiert alle Insolvenzfolgen auf beiden Kanälen", () => {
    const centre = { id: "line", worldId: "w1", operatorId: "op", name: "RE 1" };
    const cost = classifyPosting({ amountCents: 400n, costType: "energy", costCentreId: "line", reference: "run" }, centre, "w1", "op");
    expect(calculateProfitAndLoss(1_000n, [cost])).toMatchObject({ resultCents: 600n });
    for (const [expected, signals] of [
      [1, { liquidCents: 1n, twoPeriodNeedCents: 2n, overdueCents: 0n, creditScore: 9_000, contractTerminated: false, unableToPay: false }],
      [2, { liquidCents: 3n, twoPeriodNeedCents: 2n, overdueCents: 1n, creditScore: 9_000, contractTerminated: false, unableToPay: false }],
      [3, { liquidCents: 3n, twoPeriodNeedCents: 2n, overdueCents: 0n, creditScore: 2_000, contractTerminated: false, unableToPay: false }],
      [4, { liquidCents: 3n, twoPeriodNeedCents: 2n, overdueCents: 0n, creditScore: 9_000, contractTerminated: true, unableToPay: false }],
      [5, { liquidCents: 0n, twoPeriodNeedCents: 2n, overdueCents: 1n, creditScore: 0, contractTerminated: true, unableToPay: true }],
    ] as const) { const decision = evaluateInsolvency(signals); expect(decision.stage).toBe(expected); expect(decision.messages.map((m) => m.channel)).toEqual(["mailbox", "daily-report"]); }
    const prequalification = updatePrequalification({ worldId: "w1", accountId: "a", score: 7_000, creditScore: 8_000, bankruptcies: 0 }, { insolvencyAtPeriod: 3 });
    expect(prequalification).toMatchObject({ bankruptcies: 1, smallLotsOnlyUntilPeriod: 6, creditScore: 5_000 });
    const interest = accrueCreditInterest({ principalCents: 10_000n, outstandingCents: 10_000n, interestBasisPoints: 500, duePeriod: 3 });
    expect(interest.outstandingCents).toBe(10_500n);
    expect(repayCredit({ liquidCents: 2_000n, forecastPeriodNetCents: 0n, credits: [interest] }, 0, 1_000n)).toMatchObject({ liquidCents: 1_000n, credits: [{ outstandingCents: 9_500n }] });
  });

  it("lehnt i64-Ueberlaeufe vor Settlement und Ergebnisbildung ab", () => {
    const contract = {
      id: "overflow-contract", worldId: "w1", lotId: "l1", operatorId: "op1", startsAt: 0, endsAt: 1,
      orderingFeeCentsPerTrainKm: 2n, bonusCentsPerPeriod: 0n,
      penaltyRates: { punctuality: 0n, cancellation: 0n, seats: 0n, connections: 0n }, evidenceRequired: [] as string[],
    };
    expect(() => settleContract(contract, {
      trainKm: 9_223_372_036_854_775_807n,
      punctualityBasisPoints: 9_000,
      cancellations: 0,
      missingSeats: 0,
      missedConnections: 0,
      evidence: [],
    })).toThrow(/i64/);
    expect(() => calculateProfitAndLoss(0n, [
      { amountCents: 9_223_372_036_854_775_807n, costType: "vehicle", costCentreId: "l1", reference: "one" },
      { amountCents: 1n, costType: "vehicle", costCentreId: "l1", reference: "two" },
    ])).toThrow(/i64/);
  });
});
