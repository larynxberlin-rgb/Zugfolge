import { describe, expect, it, vi } from "vitest";
import {
  announceTender,
  assertOperatorActionAllowed,
  buildEconomyRelease,
  closeTender,
  closeEconomyWorld,
  completeMobilization,
  dispatchEconomyEffects,
  escalateOperator,
  openTender,
  settleContractPeriod,
  startEconomyWorld,
  submitBid,
  type Bid,
  type EconomyRelease,
  type ServiceSpecification,
} from "./index.js";

const release: EconomyRelease = buildEconomyRelease({
  version: "2026.2",
  rates: {
    trackPerTrainKmCents: 100n,
    stationPerStopCents: 100n,
    facilityPerHourCents: 100n,
    energyPerKwhCents: 100n,
    personnelPerHourCents: 100n,
    administrationPerPeriodCents: 100n,
    vehiclePerPeriodCents: 100n,
    overnightStablingPerPeriodCents: 100n,
    protectionEquipmentPerPeriodCents: 100n,
    lateInterestBasisPoints: 500,
  },
  rules: { qualityBaselinePunctualityBasisPoints: 8_500, pointsPerExtraSeat: 40, pointsPerPunctualityBasisPoint: 1, pointsPerAdditionalStop: 300, requirementFocusMaximumPoints: 1_500, contractBonusCentsPerPeriod: 100_000n, penaltyRates: { punctuality: 10n, cancellation: 10_000n, seats: 100n, connections: 1_000n }, penaltyFocusMultiplierBasisPoints: 20_000, publicOperationSurchargeBasisPoints: 2_000, failedPackageFeeStepBasisPoints: 500, failedPackageReductionStepBasisPoints: 400 },
  tenderProfiles: [
    { id: "price", weights: { price: 7_000, quality: 3_000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 1_000 },
    { id: "quality", weights: { price: 3_000, quality: 7_000 }, requirementFocus: "comfort", penaltyFocus: "connections", specialCondition: { type: "replacement-plan" }, viabilitySurchargeBasisPoints: 1_500 },
  ],
});

const specification: ServiceSpecification = {
  lines: ["S 1"], trainKmPerPeriod: 100n, stopsPerPeriod: 10n,
  serviceHoursPerPeriod: 10n, facilityHoursPerPeriod: 2n, energyKwhPerPeriod: 500n, vehicleCount: 2n, overnightUnits: 2n,
  protectionUnits: 2n,
  requirements: { minimumSeats: 100, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 4, wheelchairPlaces: 1, requiredEquipment: ["passenger-information"] },
};

const bid: Bid = {
  id: "bid-1", operatorId: "operator-1", orderingFeeCentsPerTrainKm: 100n,
  vehicle: { formationId: "formation-1", minimumSeats: 120, maximumSpeedKph: 160, operatingCostCentsPerTrainKm: 700, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2, requiredEquipment: ["passenger-information"], vehicleAgeYears: 3, traction: "electric", replacementPlan: true, evidence: { source: "zugfolge-fleet-mobilization/v1", fleetRevision: 7, snapshotHash: "a".repeat(64), formationId: "formation-1" } },
  promises: { extraSeats: 20, punctualityBasisPoints: 9_500, additionalStops: 1 }, submittedAt: 200,
};

const completeMobilizationProof = {
  source: "m5-release" as const,
  verifiedBy: "zugfolge-fleet-mobilization/v1" as const,
  fleetRevision: 7,
  snapshotHash: "a".repeat(64),
  formationIds: ["formation-1"],
  personnelDutyIds: ["duty-1"],
  pathReservationIds: ["path-1"],
};

function rustTransition(operatorId: string, kind: "operator-change" | "public-operation") {
  const publicOperation = kind === "public-operation";
  return {
    schemaVersion: "zugfolge-operating-transition-result/v1" as const,
    state: { schemaVersion: "zugfolge-operating-world-state/v1" as const, worldId: "world-1", revision: 1 },
    stateHash: "b".repeat(64),
    outcome: {
      lotId: "lot-0",
      previousOperatorId: "public",
      operatorId,
      kind,
      seamless: false,
      penaltyRequired: publicOperation,
      trainRunIds: ["train-1", "train-2"],
      livemapMarker: publicOperation ? "public-operator" as const : null,
    },
    events: [
      { eventId: "transition:0", worldId: "world-1", eventType: "operating-duty-ended", atS: 4 * 86_400, payload: { worldId: "world-1", lotId: "lot-0" } },
      { eventId: "transition:1", worldId: "world-1", eventType: "operating-transition-completed", atS: 4 * 86_400, payload: { worldId: "world-1", lotId: "lot-0" } },
      { eventId: "transition:2", worldId: "world-1", eventType: "train-operation-assigned", atS: 4 * 86_400, payload: { worldId: "world-1", trainRunId: "train-1" } },
      { eventId: "transition:3", worldId: "world-1", eventType: "train-operation-assigned", atS: 4 * 86_400, payload: { worldId: "world-1", trainRunId: "train-2" } },
      { eventId: "transition:4", worldId: "world-1", eventType: publicOperation ? "livemap-operation-marked" : "livemap-operation-cleared", atS: 4 * 86_400, payload: { worldId: "world-1", trainRunIds: ["train-1", "train-2"], marker: publicOperation ? "public-operator" : null } },
    ],
    idempotentReplay: false,
  };
}

function world() {
  return startEconomyWorld({
    worldId: "world-1", seed: 42n, durationMonths: 6, release,
    lots: Array.from({ length: 8 }, (_, index) => ({ id: `lot-${index}`, size: 100 - index, attractiveness: index })),
    authorityBudgets: [{ authorityId: "authority-1", period: 0, availableCents: 10_000_000n, committedCents: 0n }],
    accounts: ["account-1", "account-2"],
  });
}

describe("zustandsbehafteter M6-Gesamtablauf", () => {
  it("startet jedes Los mit seinem vollstaendigen Eigenbetriebs-Fahrzeugpool", () => {
    const started = startEconomyWorld({
      worldId: "world-public", seed: 7n, durationMonths: 6, release,
      lots: Array.from({ length: 8 }, (_, index) => ({ id: index === 0 ? "lot-public" : `lot-${index}`, size: 10, attractiveness: 10 })),
      authorityBudgets: [], accounts: [],
      publicVehiclePoolByLot: { "lot-public": ["vehicle-1", "vehicle-2"] },
    });
    expect(started.state.publicOperations.get("lot-public")?.vehiclePool).toEqual(["vehicle-1", "vehicle-2"]);
    expect(() => startEconomyWorld({
      worldId: "world-public", seed: 7n, durationMonths: 6, release,
      lots: Array.from({ length: 8 }, (_, index) => ({ id: index === 0 ? "lot-public" : `lot-${index}`, size: 10, attractiveness: 10 })),
      authorityBudgets: [], accounts: [],
      publicVehiclePoolByLot: { unknown: ["vehicle-1"] },
    })).toThrow(/Fahrzeugpool/);
  });

  it("führt Veröffentlichung, Gebot, Zuschlag, Mobilisierung und Periodenabrechnung aus", () => {
    let { state, effects } = world();
    expect(effects.notices).toHaveLength(2);
    const announced = announceTender(state, {
      commandId: "announce", release, recipients: ["account-1", "account-2"],
      tender: { id: "tender-1", worldId: "world-1", lotId: "lot-0", incumbentOperatorId: "public", specification, announcedAt: 100, opensAt: 150, closesAt: 3 * 86_400 + 150, operatingFrom: 4 * 86_400, contractPeriods: 2, periodDurationSeconds: 21 * 86_400, smallLot: false },
    });
    state = announced.state;
    expect(announced.effects.notices[0]?.payload).toHaveProperty("viabilityThresholdCentsPerTrainKm");
    state = openTender(state, "open", "tender-1", 150);
    state = submitBid(state, "submit", "tender-1", bid, { accountId: "account-1", period: 1, smallLot: false, minimumScore: 4_000 });
    expect(submitBid(state, "submit", "tender-1", bid, { accountId: "account-1", period: 1, smallLot: false, minimumScore: 4_000 })).toBe(state);

    const closed = closeTender(state, { commandId: "close", tenderId: "tender-1", at: 3 * 86_400 + 150, authorityId: "authority-1", budgetPeriod: 0, vehiclePool: ["reserve-1"], recipientByOperator: { "operator-1": "account-1" } });
    state = closed.state;
    expect(state.tenders.get("tender-1")?.phase).toBe("awarded");
    expect(state.budgets.get("authority-1:0")?.committedCents).toBeGreaterThan(0n);

    const mobilized = completeMobilization(state, { commandId: "mobilize", tenderId: "tender-1", at: 4 * 86_400, proof: completeMobilizationProof, failurePenaltyCents: 50_000n, recipientAccountId: "account-1", publicVehiclePool: ["reserve-1"], operatingTransition: rustTransition("operator-1", "operator-change") });
    state = mobilized.state;
    expect(state.publicOperations.has("lot-0")).toBe(false);
    expect(state.contracts.get("tender-1")?.operatorId).toBe("operator-1");

    const settled = settleContractPeriod(state, { commandId: "settle-1", contractId: "tender-1", period: 1, at: 4 * 86_400 + 1, performance: { trainKm: 100n, punctualityBasisPoints: 9_600, cancellations: 0, missingSeats: 0, missedConnections: 0, evidence: ["vehicles", "personnel", "paths"] }, costs: [{ amountCents: 1_000n, costType: "energy", costCentreId: "lot-0", reference: "period-1" }] });
    expect(settled.result.resultCents).toBeGreaterThan(0n);
    expect(settled.effects.journal[0]).toMatchObject({ worldId: "world-1", operatorId: "operator-1" });
    expect(() => settleContractPeriod(settled.state, { commandId: "settle-retry-with-new-id", contractId: "tender-1", period: 1, at: 4 * 86_400 + 2, performance: { trainKm: 100n, punctualityBasisPoints: 9_600, cancellations: 0, missingSeats: 0, missedConnections: 0, evidence: ["vehicles", "personnel", "paths"] }, costs: [] })).toThrow(/bereits abgerechnet/);
  });

  it("lässt eine fehlgeschlagene Mobilisierung atomar auf Eigenbetrieb und Pönale fallen", () => {
    let { state } = world();
    state = announceTender(state, { commandId: "a", release, recipients: [], tender: { id: "t", worldId: "world-1", lotId: "lot-0", incumbentOperatorId: "public", specification, announcedAt: 100, opensAt: 150, closesAt: 3 * 86_400 + 150, operatingFrom: 4 * 86_400, contractPeriods: 2, periodDurationSeconds: 21 * 86_400, smallLot: false } }).state;
    state = openTender(state, "o", "t", 150);
    state = submitBid(state, "s", "t", bid, { accountId: "account-1", period: 1, smallLot: false, minimumScore: 4_000 });
    state = closeTender(state, { commandId: "c", tenderId: "t", at: 3 * 86_400 + 150, authorityId: "authority-1", budgetPeriod: 0, vehiclePool: ["public-1"], recipientByOperator: { "operator-1": "account-1" } }).state;
    const failed = completeMobilization(state, { commandId: "m", tenderId: "t", at: 4 * 86_400, proof: { ...completeMobilizationProof, personnelDutyIds: [] }, failurePenaltyCents: 50_000n, recipientAccountId: "account-1", publicVehiclePool: ["public-1"], operatingTransition: rustTransition("public", "public-operation") });
    expect(failed.state.publicOperations.get("lot-0")?.livemapMarker).toBe("public-operator");
    expect(failed.state.contracts.has("t")).toBe(false);
    expect(failed.effects.journal[0]?.postings[0]?.costType).toBe("penalty");
    expect(failed.state.prequalifications.get("account-1")?.score).toBe(3_500);
  });

  it("liquidiert das EVU, beendet Verträge, übernimmt den Verkehr und sperrt Reset-Angebote", () => {
    let { state } = world();
    state = announceTender(state, { commandId: "a", release, recipients: [], tender: { id: "t", worldId: "world-1", lotId: "lot-0", incumbentOperatorId: "public", specification, announcedAt: 100, opensAt: 150, closesAt: 3 * 86_400 + 150, operatingFrom: 4 * 86_400, contractPeriods: 2, periodDurationSeconds: 21 * 86_400, smallLot: false } }).state;
    state = openTender(state, "o", "t", 150);
    state = submitBid(state, "s", "t", bid, { accountId: "account-1", period: 1, smallLot: false, minimumScore: 4_000 });
    state = closeTender(state, { commandId: "c", tenderId: "t", at: 3 * 86_400 + 150, authorityId: "authority-1", budgetPeriod: 0, vehiclePool: [], recipientByOperator: { "operator-1": "account-1" } }).state;
    state = completeMobilization(state, { commandId: "m", tenderId: "t", at: 4 * 86_400, proof: completeMobilizationProof, failurePenaltyCents: 1n, recipientAccountId: "account-1", publicVehiclePool: [], operatingTransition: rustTransition("operator-1", "operator-change") }).state;
    const insolvency = escalateOperator(state, { commandId: "i", operatorId: "operator-1", accountId: "account-1", period: 2, at: 4 * 86_400 + 2, signals: { liquidCents: 0n, twoPeriodNeedCents: 1_000n, overdueCents: 1_000n, creditScore: 0, contractTerminated: true, unableToPay: true } });
    expect(insolvency.decision).toMatchObject({ stage: 5, liquidated: true, publicOperatorTakesOver: true });
    expect(insolvency.effects.notices).toHaveLength(2);
    expect(insolvency.state.contracts.has("t")).toBe(false);
    expect(insolvency.state.publicOperations.has("lot-0")).toBe(true);
    expect(insolvency.state.prequalifications.get("account-1")).toMatchObject({ bankruptcies: 1, smallLotsOnlyUntilPeriod: 5 });
    expect(() => assertOperatorActionAllowed(insolvency.state, "operator-1", "path")).toThrow(/gesperrt/);
    expect(() => assertOperatorActionAllowed(insolvency.state, "operator-1", "credit")).toThrow(/gesperrt/);
    expect(() => assertOperatorActionAllowed(insolvency.state, "operator-1", "purchase")).toThrow(/gesperrt/);
    const ended = closeEconomyWorld(insolvency.state, "world-end");
    expect(ended.prequalifications.size).toBe(0);
    expect(ended.publicOperations.size).toBe(0);
  });

  it("isoliert Welten, prüft Release-Pinnung und dispatcht Ledger vor Nachrichten", async () => {
    const { state } = world();
    expect(() => announceTender(state, { commandId: "wrong-world", release, recipients: [], tender: { id: "t", worldId: "world-2", lotId: "lot-0", incumbentOperatorId: "public", specification, announcedAt: 100, opensAt: 150, closesAt: 3 * 86_400 + 150, operatingFrom: 4 * 86_400, contractPeriods: 2, periodDurationSeconds: 21 * 86_400, smallLot: false } })).toThrow(/Weltisolation/);
    const changedRelease = buildEconomyRelease({ version: "other", rates: release.rates, rules: release.rules, tenderProfiles: release.tenderProfiles });
    expect(() => announceTender(state, { commandId: "wrong-release", release: changedRelease, recipients: [], tender: { id: "t", worldId: "world-1", lotId: "lot-0", incumbentOperatorId: "public", specification, announcedAt: 100, opensAt: 150, closesAt: 3 * 86_400 + 150, operatingFrom: 4 * 86_400, contractPeriods: 2, periodDurationSeconds: 21 * 86_400, smallLot: false } })).toThrow(/Pinnung/);
    const calls: string[] = [];
    const postJournal = vi.fn(async () => { calls.push("journal"); });
    const sendNotice = vi.fn(async () => { calls.push("notice"); });
    await dispatchEconomyEffects({ journal: [{ worldId: "world-1", operatorId: "op", idempotencyKey: "x", at: 1, description: "x", postings: [], revenueCents: 0n }], notices: [{ id: "notice-x", worldId: "world-1", recipientAccountId: "a", type: "x", at: 1, payload: {} }] }, { postJournal, sendNotice });
    expect(calls).toEqual(["journal", "notice"]);
  });
});
