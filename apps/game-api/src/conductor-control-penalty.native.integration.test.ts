import { expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { dailyOperationReports, domainEvents, ledgerEntries, ledgerTransactions, regionalSimulationStates } from "@zugfolge/db";
import { createEconomyPlatformAdapters, createTender, dispatchEconomyOutbox, ECONOMY_COST_TYPES, ensureLedgerAccount,
  ledgerAccountBalance, loadConfirmedFareContractRevenues, persistEconomyTransition, settleContractPeriod,
  STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN, startEconomyWorld, type EconomyWorldState, type ServiceSpecification } from "@zugfolge/economy";
import { OPERATIONAL_SIMULATION_COMMAND_SCHEMA, type FareControlPolicyV1, type OperationalSimulationState } from "@zugfolge/runtime-native";
import { createConductorSessionNativeFixture, hasSessionNativeFixture } from "./conductor-session.native-fixture.js";
import { fareControlFixtureEconomy } from "./conductor-control.native-fixture.js";
import { controlRecord } from "./conductor-control-runtime.js";
import { generateDailyOperationReports } from "./daily-reports.js";

const DAY = 86_400;
const nativeIt = hasSessionNativeFixture ? it : it.skip;
nativeIt("führt echte Polizeihaltverspätung über den nativen Tagesfahrtbeleg in M6 und das bestehende Ledger", async () => {
  // Vollständiger expliziter Einfahrten-Abnahmevertrag; diese Probe gibt die
  // allgemeine, wegen #518 noch unvollständige HTTP-Abrechnung nicht frei.
  const contractId = "explicit-one-service-contract", serviceDay = "1970-01-01";
  const f = await createConductorSessionNativeFixture({ async evidence() { return { encounterEvidence: [], controlReceipts: [] }; },
    async apply(_tx, _context, _state, effects) { if (effects.length) throw new Error("Diese Betriebsprobe erzeugt keine Dialogaktionen."); } },
  { oneServiceContract: { lotId: contractId, serviceDay, requiredSeats: 120, terminalArrivalMs: 3_000_000 } });
  try {
    const { worldId, operatorId, trainRunId } = f.access;
    f.clock.nowMs += 1;
    await f.apply("penalty:before-middle-arrival", { type: "advance-to", atMs: f.clock.nowMs });
    const [head] = await f.db.select().from(regionalSimulationStates).where(eq(regionalSimulationStates.worldId, worldId));
    const before = f.native.operational.restore(head!.state as OperationalSimulationState, head!.initializationHash);
    const train = controlRecord(controlRecord(before.state.world["trains"])[trainRunId]);
    const stops = (controlRecord(controlRecord(train["passengerStops"])["plan"])["stops"] as unknown[]).map(controlRecord);
    const finishAt = DAY * 1000 + 1;
    const baseline = await f.native.operational.apply(before.state, { schemaVersion: OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
      worldId, regionId: f.initialization.regionId, commandId: "penalty:baseline", expectedStateHash: before.stateHash,
      expectedRevision: before.state.revision, expectedPublisherSequence: before.state.publisherSequence,
      command: { type: "advance-to", atMs: finishAt } });
    const baselineOutcome = baseline.events.find((event) => event["kind"] === "train-outcome");
    expect(baselineOutcome).toBeDefined();
    const original = JSON.parse(String(baselineOutcome!["detail"]));
    expect(original.delaySeconds).toBeLessThanOrEqual(300);
    const policy: FareControlPolicyV1 = { schema: "zugfolge-fare-control-policy/v1", policyId: "explicit-penalty-hold", revision: 1,
      worldId, schedulePeriodId: "explicit-one-service-period", contentHash: "", maxPoliceHoldsPerTrainRun: 1,
      eligibleReasons: ["identity_refusal", "concrete_danger"], targetRule: "next_unreached_scheduled_passenger_stop",
      providerByStopId: Object.fromEntries(stops.map((stop) => [String(stop["stopId"]), "explicit-test-police"])),
      maxWaitMs: 3_600_000, policeResponseModelId: "explicit-unavailable-before-timeout", policeResponseModelHash: "a".repeat(64),
      publicCause: "authority.police.fare-control" };
    policy.contentHash = f.native.operational.fareControlPolicyHash!(policy);
    await f.apply("penalty:policy", { type: "set-fare-control-policy", policy });
    await f.apply("penalty:request", { type: "request-fare-control-hold", request: { trainId: trainRunId,
      caseId: "explicit-authorized-control-reference", reason: "identity_refusal", causalityId: "penalty:native-police" } });
    f.clock.nowMs = finishAt;
    const finished = await f.apply("penalty:finish", { type: "advance-to", atMs: finishAt });
    const again = await f.apply("penalty:finish", { type: "advance-to", atMs: finishAt });
    expect(again.stateHash).toBe(finished.stateHash);
    const events = await f.db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId));
    const outcomes = events.filter((event) => event.eventType === "operations.train-outcome");
    expect(outcomes).toHaveLength(1);
    const outcome = controlRecord(outcomes[0]!.payload);
    expect(outcome).toMatchObject({ worldId, operatorId, lotId: contractId, serviceDay, status: "completed",
      minimumSeatsProvided: 120, missingSeats: 0, missedConnections: 0, evidenceComplete: true });
    expect(Number(outcome["delaySeconds"])).toBeGreaterThan(300);
    expect(Number(outcome["actualArrivalMs"])).toBeGreaterThan(original.actualArrivalMs);
    expect(outcome["distanceMm"]).toBe(original.distanceMm);
    const holdEvents = events.filter((event) => event.eventType.startsWith("operations.fare-control"));
    expect(holdEvents.length).toBeGreaterThanOrEqual(3);
    await generateDailyOperationReports(f.db, serviceDay, new Date(finishAt));
    const [report] = await f.db.select().from(dailyOperationReports).where(and(eq(dailyOperationReports.worldId, worldId),
      eq(dailyOperationReports.operatorId, operatorId), eq(dailyOperationReports.serviceDay, serviceDay)));
    const measured = controlRecord(controlRecord(controlRecord(report!.projection)["contracts"])[contractId]);
    expect(measured["knownServicesComplete"]).toBe(true);
    expect(measured["plannedServiceRunIds"]).toEqual([`${trainRunId}:service-day:${serviceDay}`]);
    expect(measured["missingServiceRunIds"]).toEqual([]);
    expect(measured["dayPlanComplete"]).toBe(false);
    expect(measured["evidenceComplete"]).toBe(false); // Kein erfundener allgemeiner Day-Close.
    const runs = controlRecord(measured["trainRuns"]);
    expect(runs).toMatchObject({ total: 1, punctual: 0, cancelled: 0, missingSeats: 0, missedConnections: 0 });
    const economy = fareControlFixtureEconomy();
    const started = startEconomyWorld({ worldId, seed: 73n, durationMonths: 6, release: economy, authorityBudgets: [], accounts: [],
      lots: Array.from({ length: 8 }, (_, index) => ({ id: index === 0 ? contractId : `lot-${index}`, size: 100, attractiveness: 100 })) });
    const specification: ServiceSpecification = { lines: ["Explizite Einfahrtenprobe"], trainKmPerPeriod: 10n, stopsPerPeriod: 3n,
      serviceHoursPerPeriod: 2n, facilityHoursPerPeriod: 1n, energyKwhPerPeriod: 1n, vehicleCount: 1n, overnightUnits: 1n, protectionUnits: 1n,
      requirements: { minimumSeats: 120, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 0, wheelchairPlaces: 0, requiredEquipment: [] } };
    // Explizite bereits vor dem Weltepoch abgeschlossene Testvergabe.
    const tender = createTender({ id: contractId, worldId, lotId: contractId, incumbentOperatorId: operatorId, specification,
      profile: economy.tenderProfiles[0]!, release: economy, announcedAt: -4 * DAY, opensAt: -4 * DAY, closesAt: -DAY,
      operatingFrom: 0, contractPeriods: 2, periodDurationSeconds: DAY, smallLot: false });
    const state: EconomyWorldState = { ...started.state, tenders: new Map([[contractId, { phase: "awarded", tender, bids: [] }]]),
      contracts: new Map([[contractId, { id: contractId, worldId, lotId: contractId, operatorId, startsAt: 0, endsAt: 2 * DAY,
        orderingFeeCentsPerTrainKm: 100000n, bonusCentsPerPeriod: 0n,
        penaltyRates: { punctuality: 1n, cancellation: 0n, seats: 0n, connections: 0n }, evidenceRequired: [`daily-report:${report!.id}`] }]]) };
    await persistEconomyTransition(f.db, { state, effects: { notices: [], journal: [] }, expectedRevision: null,
      committedAt: new Date(0), enqueuedAt: new Date(0) });
    const settlement = settleContractPeriod(state, { commandId: "penalty:actual-settlement", contractId, period: 0, at: DAY,
      performance: { trainKm: BigInt(String(runs["trainKm"])), minimumSeatsProvided: Number(runs["minimumSeatsProvided"]),
        punctualityBasisPoints: Number(BigInt(Number(runs["punctual"])) * 10000n / BigInt(Number(runs["total"]))),
        cancellations: Number(runs["cancelled"]), missingSeats: Number(runs["missingSeats"]), missedConnections: Number(runs["missedConnections"]),
        evidence: [`daily-report:${report!.id}`] }, costs: [] });
    const journal = settlement.effects.journal[0]!;
    expect(journal.contractRevenueEvidence?.penaltyCents).toBe("9000");
    const gross = BigInt(journal.contractRevenueEvidence!.orderingFeeCents);
    expect(journal.revenueCents).toBe(gross - 9000n);
    await persistEconomyTransition(f.db, { ...settlement, expectedRevision: 0, committedAt: new Date(DAY * 1000), enqueuedAt: new Date(DAY * 1000) });
    const plan = STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN;
    const cash = await ensureLedgerAccount(f.db, { worldId, operatorId, name: plan.cashAccountName });
    const revenue = await ensureLedgerAccount(f.db, { worldId, operatorId, name: plan.revenueAccountName });
    const costAccountIds = Object.fromEntries(await Promise.all(ECONOMY_COST_TYPES.map(async (type) => [type,
      (await ensureLedgerAccount(f.db, { worldId, operatorId, name: plan.costAccountNames[type] })).id]))) as Record<(typeof ECONOMY_COST_TYPES)[number], string>;
    const adapters = createEconomyPlatformAdapters({ db: f.db, accountsByOperator: { [operatorId]: { cashAccountId: cash.id, revenueAccountId: revenue.id, costAccountIds } } });
    await dispatchEconomyOutbox(f.db, worldId, adapters, new Date(DAY * 1000));
    await dispatchEconomyOutbox(f.db, worldId, adapters, new Date(DAY * 1000));
    const confirmed = await loadConfirmedFareContractRevenues(f.db, { worldId, operatorId, nowMs: DAY * 1000 });
    expect(confirmed).toHaveLength(1); expect(confirmed[0]!.evidence.penaltyCents).toBe("9000");
    expect(await ledgerAccountBalance(f.db, { worldId, ledgerAccountId: cash.id })).toBe(gross - 9000n);
    const journals = await f.db.select().from(ledgerTransactions).where(and(eq(ledgerTransactions.worldId, worldId), eq(ledgerTransactions.operatorId, operatorId)));
    const entries = await f.db.select().from(ledgerEntries).where(eq(ledgerEntries.worldId, worldId));
    expect(journals).toHaveLength(1);
    expect(entries.reduce((sum, row) => sum + row.amountCents, 0n)).toBe(0n);
    expect(() => settleContractPeriod(settlement.state, { commandId: "penalty:second-settlement", contractId, period: 0, at: DAY,
      performance: { trainKm: 0n, punctualityBasisPoints: 0, cancellations: 0, missingSeats: 0, missedConnections: 0, evidence: [] }, costs: [] })).toThrow("bereits abgerechnet");
  } finally { await f.dispose(); }
}, 180_000);
