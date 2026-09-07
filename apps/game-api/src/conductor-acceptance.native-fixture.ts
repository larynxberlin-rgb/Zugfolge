/** Zusammenhängender Abnahmekorpus: echte Produzenten, ausdrücklich fiktiver Vertrag. */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { conductorControlStates, dailyOperationReports, domainEvents, ledgerEntries, ledgerTransactions, regionalSimulationStates, worlds } from "@zugfolge/db";
import { awardTender, createEconomyPlatformAdapters, createTender, dispatchEconomyOutbox, ECONOMY_COST_TYPES, ensureLedgerAccount,
  loadConfirmedFareContractRevenues, loadEconomyWorldStateForUpdate, persistEconomyTransition, settleContractPeriod,
  resolveVehicleConcept, STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN, type Bid, type ServiceSpecification } from "@zugfolge/economy";
import type { OperationalSimulationState } from "@zugfolge/runtime-native";
import { createFareControlNativeFixture, type FareControlNativeFixtureOptions } from "./conductor-control.native-fixture.js";
import { controlRecord, type FareControlState } from "./conductor-control-runtime.js";
import { generateDailyOperationReports } from "./daily-reports.js";

const DAY_S = 86_400;
export const CONDUCTOR_ACCEPTANCE_SOURCE = Object.freeze({
  demandSeed: "138", contractId: "explicit-test-lot-0", serviceDay: "1970-01-01", requiredSeats: 120,
  terminalArrivalMs: 3_000_000, policeResponseMs: 3_540_000, policeMaxWaitMs: 3_600_000,
});

const contractFixture: NonNullable<FareControlNativeFixtureOptions["economyFixture"]> = (state, operatorId, fixture) => {
  const source = CONDUCTOR_ACCEPTANCE_SOURCE, contractId = source.contractId, release = state.release;
  const formationId = fixture.initialization.trains[0]!.formationVersionId;
  const formation = fixture.checkpoint.snapshot.formations.find((row) => row.id === formationId);
  assert.ok(formation);
  const vehicle = resolveVehicleConcept(fixture.checkpoint.snapshot, { formationId,
    fleetRevision: fixture.checkpoint.snapshot.revision, snapshotHash: fixture.checkpoint.snapshotHash }, {
    operatorId, serviceLineIds: formation.serviceLineIds, operatingFrom: formation.availableFrom });
  const specification: ServiceSpecification = { lines: formation.serviceLineIds, trainKmPerPeriod: 10n,
    stopsPerPeriod: 3n, serviceHoursPerPeriod: 2n, facilityHoursPerPeriod: 1n, energyKwhPerPeriod: 1n,
    vehicleCount: 1n, overnightUnits: 1n, protectionUnits: 1n, requirements: { minimumSeats: source.requiredSeats,
      firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 0, wheelchairPlaces: 0, requiredEquipment: [] } };
  // Fiktive Vergabe vor Weltepoche; Kapazität/Leistung kommen später ausschließlich
  // aus dem wirklichen M5-Compiler und dem nativen Abschluss dieser einen Fahrt.
  const tender = createTender({ id: contractId, worldId: state.worldId, lotId: contractId, incumbentOperatorId: operatorId,
    specification, profile: release.tenderProfiles[0]!, release, announcedAt: -4 * DAY_S, opensAt: -4 * DAY_S,
    closesAt: -DAY_S, operatingFrom: formation.availableFrom, contractPeriods: 2, periodDurationSeconds: DAY_S, smallLot: false });
  const winningBid: Bid = { id: "explicit-acceptance-winning-bid", operatorId, orderingFeeCentsPerTrainKm: 10000n,
    vehicle, promises: { extraSeats: 0, punctualityBasisPoints: 9000, additionalStops: 0 }, submittedAt: -2 * DAY_S };
  assert.equal(awardTender(tender, [winningBid], -DAY_S).winner?.id, winningBid.id);
  return { ...state, tenders: new Map([[contractId, { phase: "awarded", tender, bids: [winningBid], winningBid }]]),
    contracts: new Map([[contractId, { id: contractId, worldId: state.worldId, lotId: contractId, operatorId,
      startsAt: formation.availableFrom, endsAt: formation.availableFrom + 2 * DAY_S,
      orderingFeeCentsPerTrainKm: winningBid.orderingFeeCentsPerTrainKm, bonusCentsPerPeriod: 0n,
      penaltyRates: { punctuality: 1n, cancellation: 0n, seats: 0n, connections: 0n },
      evidenceRequired: [`explicit-native-day:${source.serviceDay}:${contractId}`] }]]) };
};

export async function createConductorAcceptanceNativeFixture(options: {
  readonly demandSeed?: string;
  readonly sessionFixture?: Omit<NonNullable<FareControlNativeFixtureOptions["sessionFixture"]>, "oneServiceContract">;
} = {}) {
  const source = { ...CONDUCTOR_ACCEPTANCE_SOURCE, demandSeed: options.demandSeed ?? CONDUCTOR_ACCEPTANCE_SOURCE.demandSeed };
  const f = await createFareControlNativeFixture({ demandSeed: source.demandSeed, identityRefusalBasisPoints: 5000,
    invalidDocumentPresentedBasisPoints: 10_000, policeResponseMs: source.policeResponseMs, policeMaxWaitMs: source.policeMaxWaitMs,
    sessionFixture: { ...options.sessionFixture, oneServiceContract: { lotId: source.contractId, serviceDay: source.serviceDay,
      requiredSeats: source.requiredSeats, terminalArrivalMs: source.terminalArrivalMs } }, economyFixture: contractFixture });
  const { worldId, operatorId, trainRunId } = f.access;
  const formation = f.checkpoint.snapshot.formations.find((row) => row.id === f.initialization.trains[0]!.formationVersionId)!;
  const settlementReadyAtMs = (formation.availableFrom + DAY_S) * 1000 + 1;
  return { ...f, acceptanceSource: source, settlementReadyAtMs,
    async nextAcceptanceWakeup() {
      // Nur Node-seitige Fahrsteuerung der Abnahme. Gespeicherte Zeitgrenzen
      // werden aus genau dem nativ restaurierten DB-Kopf gelesen.
      const [head] = await f.db.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, f.initialization.regionId)));
      assert.ok(head?.initializationHash);
      assert.equal(head.initializationHash, f.dependencies.regionBindings()[0]!.initializationHash);
      const actual = f.native.operational.restore(head.state as OperationalSimulationState, head.initializationHash);
      assert.equal(actual.stateHash, head.stateHash);
      assert.equal(actual.state.world["worldId"], worldId);
      const world = actual.state.world, nowMs = Number(world["nowMs"]);
      const candidates: { atMs: number; cause: string }[] = [];
      const add = (atMs: unknown, cause: string) => {
        if (typeof atMs === "number" && Number.isSafeInteger(atMs) && atMs >= nowMs) candidates.push({ atMs, cause });
      };
      for (const key of ["scheduledMotionEnds", "scheduledContinuationDue", "scheduledPassengerDepartures"]) {
        // Rust lässt ausschließlich die leere Menge der Fahrgastabfahrten weg.
        if (key === "scheduledPassengerDepartures" && world[key] === undefined) continue;
        assert.ok(Array.isArray(world[key]), `Der gespeicherte Kalender ${key} fehlt.`);
        for (const row of world[key] as unknown[]) add(controlRecord(row)["atMs"], key);
      }
      const fareControl = controlRecord(world["fareControlState"]);
      assert.ok(Array.isArray(fareControl["scheduled"]));
      for (const row of fareControl["scheduled"]) add(controlRecord(row)["atMs"], "operational-police-calendar");
      const holds = controlRecord(fareControl["holds"]);
      for (const value of Object.values(holds)) {
        const hold = controlRecord(value);
        if (hold["releasedAtMs"] === null) add(hold["deadlineMs"], "operational-police-deadline");
      }
      const [stored] = await f.db.select().from(conductorControlStates).where(and(eq(conductorControlStates.worldId, worldId),
        eq(conductorControlStates.operatorId, operatorId)));
      if (stored !== undefined) {
        const state = f.controlRuntime.restore(stored.state as FareControlState, stored.stateHash);
        assert.equal(state.worldId, worldId); assert.equal(state.operatorId, operatorId);
        assert.equal(state.revision, stored.revision); assert.equal(state.nowMs, stored.atMs);
        const controlAtMs = f.controlRuntime.nextWakeup(state);
        if (controlAtMs !== null) add(Math.max(nowMs, controlAtMs), "native-control-wakeup");
        for (const plan of Object.values(state.policePlans).filter((row) => row.resolution === "pending")) {
          const hold = controlRecord(holds[plan.trainRunId]);
          assert.equal(hold["holdId"], plan.holdId);
          if (hold["activatedAtMs"] === null || hold["releasedAtMs"] !== null) continue;
          const evidence = { worldId, trainRunId: plan.trainRunId, holdId: plan.holdId, targetStopId: hold["targetStopId"],
            modelHash: hold["modelHash"], operationalStateHash: actual.stateHash, activatedAtMs: hold["activatedAtMs"],
            deadlineMs: hold["deadlineMs"], releasedAtMs: null, targetUnavailable: false, outcome: "pending" };
          if (f.controlRuntime.policeDue(plan, evidence, nowMs) !== null) add(nowMs, "native-police-response-due");
          else {
            const dueAtMs = Number(hold["activatedAtMs"]) + Number(plan["responseAfterActivationMs"]);
            assert.ok(Number.isSafeInteger(dueAtMs));
            // Der gespeicherte Zeitpunkt zählt nur, wenn der echte Kern dort
            // tatsächlich eine Antwort erlaubt; keine gewählte Ergebnisannahme.
            if (dueAtMs > nowMs && f.controlRuntime.policeDue(plan, evidence, dueAtMs) !== null) add(dueAtMs, "native-police-response-due");
          }
        }
      }
      candidates.sort((a, b) => a.atMs - b.atMs || a.cause.localeCompare(b.cause));
      return { nowMs, atMs: candidates[0]?.atMs ?? null, operationalStateHash: actual.stateHash, candidates };
    },
    async settleAcceptanceContract() {
      // Tatsächlicher DB-Clock-/Restorebeleg statt frei gewählter Abrechnungszeit.
      const [head] = await f.db.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, worldId),
        eq(regionalSimulationStates.regionId, f.initialization.regionId)));
      assert.ok(head);
      assert.equal(head.initializationHash, f.dependencies.regionBindings()[0]!.initializationHash);
      assert.ok(head.initializationHash !== null);
      const actual = f.native.operational.restore(head.state as OperationalSimulationState, head.initializationHash);
      assert.equal(actual.stateHash, head.stateHash);
      assert.equal(actual.state.world["worldId"], worldId);
      const nowMs = Number(actual.state.world["nowMs"]);
      assert.ok(Number.isSafeInteger(nowMs) && nowMs >= settlementReadyAtMs, "Die tatsächliche erste Vertragsperiode ist noch nicht beendet.");
      const outcomes = (await f.db.select().from(domainEvents).where(and(eq(domainEvents.worldId, worldId),
        eq(domainEvents.eventType, "operations.train-outcome")))).filter((row) => {
        const value = controlRecord(row.payload);
        return value["operatorId"] === operatorId && value["lotId"] === source.contractId && value["serviceDay"] === source.serviceDay;
      });
      assert.equal(outcomes.length, 1, "Der explizite Vertrag benötigt genau einen tatsächlichen Tagesfahrtabschluss.");
      const outcome = controlRecord(outcomes[0]!.payload);
      assert.equal(outcome["trainRunId"], trainRunId);
      assert.equal(outcome["evidenceComplete"], true);
      await generateDailyOperationReports(f.db, source.serviceDay, new Date(nowMs));
      const [report] = await f.db.select().from(dailyOperationReports).where(and(eq(dailyOperationReports.worldId, worldId),
        eq(dailyOperationReports.operatorId, operatorId), eq(dailyOperationReports.serviceDay, source.serviceDay)));
      assert.ok(report);
      const measured = controlRecord(controlRecord(controlRecord(report.projection)["contracts"])[source.contractId]);
      assert.equal(measured["knownServicesComplete"], true);
      assert.deepEqual(measured["plannedServiceRunIds"], [`${trainRunId}:service-day:${source.serviceDay}`]);
      assert.deepEqual(measured["missingServiceRunIds"], []);
      assert.equal(measured["dayPlanComplete"], false);
      assert.equal(measured["evidenceComplete"], false); // #518 bleibt unverändert gesperrt.
      const runs = controlRecord(measured["trainRuns"]);
      assert.equal(runs["total"], 1);
      assert.equal(runs["minimumSeatsProvided"], outcome["minimumSeatsProvided"]);
      const journalEffectId = "acceptance:actual-one-service-settlement:settlement";
      await f.db.transaction(async (tx) => {
        await tx.select().from(worlds).where(eq(worlds.id, worldId)).for("update");
        const state = await loadEconomyWorldStateForUpdate(tx, worldId);
        assert.ok(state);
        if (state.settledPeriods.has(`${source.contractId}:0`)) return;
        const transition = settleContractPeriod(state, { commandId: "acceptance:actual-one-service-settlement", contractId: source.contractId,
          period: 0, at: Math.floor(nowMs / 1000), performance: { trainKm: BigInt(String(runs["trainKm"])),
            minimumSeatsProvided: Number(runs["minimumSeatsProvided"]),
            punctualityBasisPoints: Number(BigInt(Number(runs["punctual"])) * 10000n / BigInt(Number(runs["total"]))),
            cancellations: Number(runs["cancelled"]), missingSeats: Number(runs["missingSeats"]), missedConnections: Number(runs["missedConnections"]),
            evidence: [`explicit-native-day:${source.serviceDay}:${source.contractId}`, `daily-report:${report.id}`] }, costs: [] });
        assert.equal(transition.effects.journal[0]!.idempotencyKey, journalEffectId);
        await persistEconomyTransition(tx, { ...transition, expectedRevision: state.revision,
          committedAt: new Date(nowMs), enqueuedAt: new Date(nowMs) });
      });
      const plan = STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN;
      const cash = await ensureLedgerAccount(f.db, { worldId, operatorId, name: plan.cashAccountName });
      const revenue = await ensureLedgerAccount(f.db, { worldId, operatorId, name: plan.revenueAccountName });
      const costAccountIds = Object.fromEntries(await Promise.all(ECONOMY_COST_TYPES.map(async (type) => [type,
        (await ensureLedgerAccount(f.db, { worldId, operatorId, name: plan.costAccountNames[type] })).id]))) as Record<(typeof ECONOMY_COST_TYPES)[number], string>;
      const adapters = createEconomyPlatformAdapters({ db: f.db, accountsByOperator: { [operatorId]: {
        cashAccountId: cash.id, revenueAccountId: revenue.id, costAccountIds } } });
      await dispatchEconomyOutbox(f.db, worldId, adapters, new Date(nowMs));
      await dispatchEconomyOutbox(f.db, worldId, adapters, new Date(nowMs));
      const receipts = (await loadConfirmedFareContractRevenues(f.db, { worldId, operatorId, nowMs }))
        .filter((row) => row.evidence.journalEffectId === journalEffectId);
      assert.equal(receipts.length, 1);
      const receipt = receipts[0]!;
      const journals = await f.db.select().from(ledgerTransactions).where(and(eq(ledgerTransactions.worldId, worldId),
        eq(ledgerTransactions.operatorId, operatorId), eq(ledgerTransactions.idempotencyKey, journalEffectId)));
      assert.equal(journals.length, 1);
      assert.equal(journals[0]!.id, receipt.ledgerTransactionId);
      const entries = await f.db.select().from(ledgerEntries).where(and(eq(ledgerEntries.worldId, worldId),
        eq(ledgerEntries.transactionId, receipt.ledgerTransactionId)));
      assert.equal(entries.reduce((sum, entry) => sum + entry.amountCents, 0n), 0n);
      const cashDelta = entries.filter((row) => row.ledgerAccountId === cash.id).reduce((sum, row) => sum + row.amountCents, 0n);
      assert.equal(cashDelta, BigInt(receipt.evidence.orderingFeeCents) + BigInt(receipt.evidence.bonusCents) - BigInt(receipt.evidence.penaltyCents));
      await f.advanceControl();
      const holdValue = controlRecord(controlRecord(actual.state.world["fareControlState"])["holds"])[trainRunId];
      const hold = holdValue === undefined ? undefined : controlRecord(holdValue);
      if (hold !== undefined) { assert.equal(hold["worldId"], worldId); assert.equal(hold["trainRunId"], trainRunId); }
      const operationalHoldProof = hold === undefined ? null : Object.fromEntries(["holdId", "caseIds", "targetStopId", "requestedAtMs",
        "activatedAtMs", "deadlineMs", "releasedAtMs", "outcome", "policyHash", "modelHash"].map((key) => [key, hold[key]]));
      return { schemaVersion: "conductor-acceptance-settlement/v1" as const, testOnly: true, worldId, operatorId, trainRunId,
        contractId: source.contractId, serviceDay: source.serviceDay, operationalStateHash: actual.stateHash,
        outcomeWorldSequence: outcomes[0]!.sequence, outcome, operationalHoldProof, reportId: report.id,
        dayPlanComplete: measured["dayPlanComplete"], generalEvidenceComplete: measured["evidenceComplete"],
        contractRevenue: receipt.evidence, ledgerTransactionId: receipt.ledgerTransactionId, cashDeltaCents: cashDelta.toString(),
        ledgerBalanced: true, outboxRetryTransactionCount: journals.length };
    } };
}
