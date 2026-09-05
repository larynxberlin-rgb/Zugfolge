import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_FOLDER, schema, worlds } from "@zugfolge/db";
import {
  createGtfsPlanningEnvelope,
  gtfsPlanningIdentityNamespace,
  gtfsPlanningLotId,
  gtfsPlanningPatternId,
  type GtfsPlanningSnapshot,
} from "@zugfolge/gtfs";
import type { OperatingRuntime } from "@zugfolge/runtime-native";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";

import { buildEconomyRelease } from "./release.js";
import { EconomySchedulerMonitor, runEconomySchedulerCycle } from "./runtime.js";
import { decodeEconomyValue, encodeEconomyValue, loadEconomyWorldState, persistEconomyTransition } from "./state-store.js";
import { deriveTenderAuthorityBudgetCents, TENDER_GENERATION_SCHEMA } from "./tender-generation-policy.js";
import { generateDueTenders, seedEconomyAccount, startEconomyWorld, submitBid, type EconomyWorldState } from "./workflow.js";

const WORLD = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400;
const PERIOD = 21 * DAY;
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const instant = (seconds: number) => new Date(EPOCH + seconds * 1_000);
const release = buildEconomyRelease({
  version: "tender-generation-test-v1",
  rates: { trackPerTrainKmCents: 1n, stationPerStopCents: 1n, facilityPerHourCents: 1n, energyPerKwhCents: 1n, personnelPerHourCents: 1n, administrationPerPeriodCents: 1n, vehiclePerPeriodCents: 1n, overnightStablingPerPeriodCents: 1n, protectionEquipmentPerPeriodCents: 1n, lateInterestBasisPoints: 1 },
  rules: { qualityBaselinePunctualityBasisPoints: 8_500, pointsPerExtraSeat: 1, pointsPerPunctualityBasisPoint: 1, pointsPerAdditionalStop: 1, requirementFocusMaximumPoints: 1_000, contractBonusCentsPerPeriod: 1n, penaltyRates: { punctuality: 1n, cancellation: 1n, seats: 1n, connections: 1n }, penaltyFocusMultiplierBasisPoints: 10_000, publicOperationSurchargeBasisPoints: 2_000, failedPackageFeeStepBasisPoints: 0, failedPackageReductionStepBasisPoints: 0 },
  tenderProfiles: [
    { id: "price", weights: { price: 7_000, quality: 3_000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 1_000 },
    { id: "quality", weights: { price: 3_000, quality: 7_000 }, requirementFocus: "bicycle", penaltyFocus: "connections", viabilitySurchargeBasisPoints: 2_000 },
  ],
});

function planning(lotCount = 4) {
  const base = {
    source: { sourceId: "test-reference", feedUrl: "https://example.test/gtfs.zip", archiveSha256: "a".repeat(64), capturedAt: "2026-08-09T00:00:00.000Z", timeZone: "Europe/Berlin", sourceLicense: "CC0", attribution: "Testdaten" },
    infrastructureVersion: "playable-v1", rulesVersion: "generated-v1", serviceDates: ["20260810"],
  };
  const namespace = gtfsPlanningIdentityNamespace(base);
  const patterns = Array.from({ length: lotCount }, (_, index) => {
    const lineId = `L${index}`;
    const nodeIds = [`${lineId}:a`, `${lineId}:b`];
    return {
      id: gtfsPlanningPatternId(namespace, lineId, "0", nodeIds), lineId, directionId: "0", sourceRouteIds: [`route-${index}`], stopIds: nodeIds, stopNames: ["A", "B"], nodeIds, edgeIds: [`edge-${index}`], distanceMeters: 10_000,
      journeys: [{ id: `game-run-${index}`, sourceTripId: `reference-${index}`, serviceDate: "20260810", departureServiceSeconds: 0, arrivalServiceSeconds: 1_800, departureEpochSeconds: 1, arrivalEpochSeconds: 1_801 }],
      metrics: { journeyCount: 1, totalTrainMeters: "10000", totalStops: "2", totalServiceSeconds: "1800", totalEnergyWh: "80000", medianHeadwaySeconds: null, maximumOperatingSpanSeconds: 1_800, peakVehicles: 1 },
    };
  });
  const snapshot: GtfsPlanningSnapshot = {
    schema: "zugfolge-gtfs-planning/v2", worldId: WORLD, revision: 1, producedAt: 0, ...base, patterns,
    lots: patterns.map((pattern, index) => ({
      id: gtfsPlanningLotId(namespace, [pattern.lineId]), lineIds: [pattern.lineId], patternIds: [pattern.id], connectingNodeIds: [], size: 10, attractiveness: 100 - index, smallLot: true,
      specificationBasis: { sampleServiceDays: 1, totalTrainMeters: "10000", totalStops: "2", totalServiceSeconds: "1800", totalEnergyWh: "80000", peakVehicles: 1, facilityMinutesPerDay: 30, overnightUnits: 1, protectionUnits: 1, requirements: { minimumSeats: 120, firstClassBasisPoints: 0, accessible: true, bicyclePlaces: 8, wheelchairPlaces: 2, requiredEquipment: ["pis"] } },
    })),
  };
  return createGtfsPlanningEnvelope(snapshot);
}

function start(lotCount = 4, durationMonths: 6 | "unlimited" = 6) {
  const envelope = planning(lotCount);
  return startEconomyWorld({
    worldId: WORLD, seed: 42n, durationMonths, release, planning: envelope,
    tenderGeneration: { schemaVersion: TENDER_GENERATION_SCHEMA, authorityId: "authority", authorityBudgetCentsPerPeriod: deriveTenderAuthorityBudgetCents(envelope, WORLD, release, durationMonths), failurePenaltyCents: 0n },
    authorityBudgets: [], accounts: ["founder"], publicVehiclePoolByLot: Object.fromEntries(envelope.snapshot.lots.map((lot) => [lot.id, [`vehicle:${lot.id}`]])),
  });
}

describe("spielweltgenerierte Ausschreibungen", () => {
  it("oeffnet beim Start das erste echte Los und behaelt weitere Kalenderfenster", () => {
    const started = start();
    expect(started.state.calendar.map((entry) => entry.announcementPeriod)).toEqual([0, 1, 2, 3]);
    expect(started.state.tenders.size).toBe(1);
    const current = [...started.state.tenders.values()][0]!;
    expect(current).toMatchObject({ phase: "open", tender: { announcedAt: 0, opensAt: 0, closesAt: DAY, operatingFrom: PERIOD, planningEvidence: { snapshotHash: started.state.planning!.snapshotHash } } });
    expect(current.tender.specification.trainKmPerPeriod).toBe(210n);
    expect(started.state.publicOperations.size).toBe(4);
    expect(started.state.contracts.size).toBe(0);
    expect(started.state.budgets.get("authority:0")?.availableCents).toBeGreaterThan(0n);
    expect(started.effects.notices.map((notice) => notice.type)).toEqual(["tender-calendar-published", "tender-announced"]);
    expect(encodeEconomyValue(start())).toEqual(encodeEconomyValue(started));
  });

  it("erlaubt eine Karte mit genau einem Los und erzeugt beim Replay keine Duplikate", () => {
    const started = start(1);
    const restored = decodeEconomyValue(encodeEconomyValue(started.state)) as EconomyWorldState;
    const replay = generateDueTenders(restored, 0);
    expect(replay.state).toBe(restored);
    expect(replay.transitions).toBe(0);
    expect(replay.effects.notices).toEqual([]);
    expect(restored.tenders.size).toBe(1);
  });

  it("fordert fuer die Automatik einen geprueften Plan und laesst interne Testlose unveraendert", () => {
    const input = { worldId: WORLD, seed: 42n, durationMonths: 6 as const, release, lots: [{ id: "internal", size: 1, attractiveness: 1 }], authorityBudgets: [], accounts: [] };
    expect(startEconomyWorld(input).state.tenders.size).toBe(0);
    expect(() => startEconomyWorld({ ...input, tenderGeneration: start(1).state.tenderGeneration })).toThrow(/Angebotsplan/);
    const current = start(1).state;
    expect(() => generateDueTenders({ ...current, planning: { ...current.planning!, snapshotHash: "b".repeat(64) }, tenders: new Map() }, 0)).toThrow(/hash/);
  });

  it("fuellt ein bereits zugesagtes Budget beim naechsten Fenster nicht erneut auf", () => {
    const current = start().state;
    const budget = { authorityId: "authority", period: 1, availableCents: 12_000n, committedCents: 7_000n };
    const generated = generateDueTenders({ ...current, budgets: new Map([...current.budgets, ["authority:1", budget]]) }, PERIOD);
    expect(generated.state.budgets.get("authority:1")).toEqual(budget);
    expect([...generated.state.tenders.values()].filter((tender) => tender.phase === "open")).toHaveLength(2);
  });

  it("bindet erst spaeter gegruendete EVU beim Gebot an ihr Zuschlagskonto", () => {
    const current = seedEconomyAccount(start(1).state, { commandId: "join:late", accountId: "late-founder" });
    const tender = [...current.tenders.values()][0]!.tender;
    const next = submitBid(current, "bid:late", tender.id, {
      id: "late-bid", operatorId: "late-operator", orderingFeeCentsPerTrainKm: 1n, submittedAt: 1,
      vehicle: { ...tender.specification.requirements, formationId: "formation", maximumSpeedKph: 160, operatingCostCentsPerTrainKm: 1, vehicleAgeYears: 1, traction: "electric", replacementPlan: true, evidence: { source: "zugfolge-fleet-mobilization/v1", fleetRevision: 0, snapshotHash: "c".repeat(64), formationId: "formation" } },
      promises: { extraSeats: 0, punctualityBasisPoints: 9_500, additionalStops: 0 },
    }, { accountId: "late-founder", period: 0, smallLot: true, minimumScore: 0 });
    expect(next.tenderAutomation.get(tender.id)?.recipientByOperator["late-operator"]).toBe("late-founder");
  });

  it("kuendigt die Folgevergabe eine Periode vor Vertragsende an", () => {
    const started = start(1).state;
    const tender = [...started.tenders.values()][0]!.tender;
    const winningBid = { id: "winner", operatorId: "operator" } as never;
    const state: EconomyWorldState = {
      ...started,
      tenders: new Map([[tender.id, { phase: "awarded", tender, bids: [], winningBid }]]),
      mobilizations: new Map([[tender.id, { tenderId: tender.id, winnerOperatorId: "operator", deadline: PERIOD, completed: true }]]),
      contracts: new Map([[tender.id, { id: tender.id, worldId: WORLD, lotId: tender.lotId, operatorId: "operator", startsAt: PERIOD, endsAt: 3 * PERIOD, orderingFeeCentsPerTrainKm: 1n, bonusCentsPerPeriod: 0n, penaltyRates: release.rules.penaltyRates, evidenceRequired: [] }]]),
      publicOperations: new Map(),
    };
    expect(generateDueTenders(state, 2 * PERIOD - 1).transitions).toBe(0);
    const renewed = generateDueTenders(state, 2 * PERIOD).state;
    const next = [...renewed.tenders.values()].find((candidate) => candidate.tender.id !== tender.id)!;
    expect(next).toMatchObject({ phase: "open", tender: { announcedAt: 2 * PERIOD, operatingFrom: 3 * PERIOD, incumbentOperatorId: "operator" } });
    expect(renewed.tenderAutomation.get(next.tender.id)?.vehiclePool).toEqual([`vehicle:${tender.lotId}`]);
  });

  it("holt nach Neustart faellige Freigaben und Wiedervergaben mit ihren originalen Fristen nach", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await db.insert(worlds).values({ id: WORLD, name: "Tenderstart", schedulePeriodWeeks: 3, epoch: instant(0) });
      await persistEconomyTransition(db, { expectedRevision: null, ...start(), committedAt: instant(0), enqueuedAt: instant(0) });
      const adapters = { sendNotice: vi.fn(async () => undefined), postJournal: vi.fn(async () => undefined), publishRuntimeEvents: vi.fn(async () => undefined), operatingRuntime: {} as OperatingRuntime };
      const firstRun = await runEconomySchedulerCycle(db, instant(2 * PERIOD + DAY + 1), adapters, new EconomySchedulerMonitor(EPOCH));
      expect(firstRun.transitions).toBeGreaterThan(0);
      const restored = (await loadEconomyWorldState(db, WORLD))!;
      expect(restored.tenders.size).toBe(4);
      const starts = [...restored.tenders.values()].map((value) => value.tender.announcedAt).sort((a, b) => a - b);
      expect(starts).toEqual([0, PERIOD, 2 * PERIOD, 2 * PERIOD]);
      expect([...restored.tenders.values()].every((value) => value.phase === "failed")).toBe(true);
      expect(restored.budgets.get("authority:2")?.committedCents).toBeGreaterThan(0n);
      const replay = await runEconomySchedulerCycle(db, instant(2 * PERIOD + DAY + 1), adapters, new EconomySchedulerMonitor(EPOCH));
      expect(replay.transitions).toBe(0);
      expect(encodeEconomyValue(await loadEconomyWorldState(db, WORLD))).toEqual(encodeEconomyValue(restored));
      await runEconomySchedulerCycle(db, instant(9 * PERIOD), adapters, new EconomySchedulerMonitor(EPOCH));
      const ended = (await loadEconomyWorldState(db, WORLD))!;
      expect([...ended.tenders.values()].every((value) => value.tender.operatingFrom + value.tender.contractPeriods * PERIOD <= 8 * PERIOD)).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("behaelt nach erfolgloser Folgevergabe den Altbetreiber bis zum atomaren nativen Stichtagswechsel", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await db.insert(worlds).values({ id: WORLD, name: "Folgevergabe", schedulePeriodWeeks: 3, epoch: instant(0) });
      const started = start(1).state;
      const first = [...started.tenders.values()][0]!.tender;
      const active: EconomyWorldState = {
        ...started,
        tenders: new Map([[first.id, { phase: "awarded", tender: first, bids: [], winningBid: { id: "winner", operatorId: "operator" } as never }]]),
        mobilizations: new Map([[first.id, { tenderId: first.id, winnerOperatorId: "operator", deadline: PERIOD, completed: true }]]),
        contracts: new Map([[first.id, { id: first.id, worldId: WORLD, lotId: first.lotId, operatorId: "operator", startsAt: PERIOD, endsAt: 3 * PERIOD, orderingFeeCentsPerTrainKm: 1n, bonusCentsPerPeriod: 0n, penaltyRates: release.rules.penaltyRates, evidenceRequired: [] }]]),
        publicOperations: new Map(),
        operatingRuntimeByLot: new Map([[first.lotId, { state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId: WORLD, revision: 1 }, stateHash: "a".repeat(64) }]]),
      };
      const renewed = generateDueTenders(active, 2 * PERIOD);
      const nextTender = [...renewed.state.tenders.values()].find((value) => value.tender.id !== first.id)!.tender;
      await persistEconomyTransition(db, { expectedRevision: null, state: { ...renewed.state, revision: 0 }, effects: renewed.effects, committedAt: instant(2 * PERIOD), enqueuedAt: instant(2 * PERIOD) });
      let nativeFailure = true;
      const applyTransition: OperatingRuntime["applyTransition"] = vi.fn((state, command) => {
        expect(command).toMatchObject({ reason: "failed-tender", atS: 3 * PERIOD, nextTimetableBoundaryS: 5 * PERIOD, winnerOperatorId: "public", expectedRevision: 1 });
        if (nativeFailure) throw new Error("Runtime nicht bereit");
        return {
          schemaVersion: "zugfolge-operating-transition-result/v1", state: { ...state, revision: 2 }, stateHash: "b".repeat(64), idempotentReplay: false,
          outcome: { lotId: first.lotId, previousOperatorId: "operator", operatorId: "public", kind: "public-operation", seamless: false, penaltyRequired: false, trainRunIds: ["game-run-0"], livemapMarker: "public-operator" },
          events: ["operating-duty-ended", "operating-transition-completed", "train-operation-assigned", "livemap-operation-marked"].map((eventType, index) => ({ eventId: `${command.commandId}:${index}`, worldId: WORLD, eventType, atS: command.atS, payload: { worldId: WORLD, lotId: first.lotId, trainRunId: "game-run-0" } })),
        };
      });
      const initialize = vi.fn(() => { throw new Error("Ein vorhandener nativer Zustand darf nicht zurueckgesetzt werden"); });
      const adapters = { sendNotice: vi.fn(async () => undefined), postJournal: vi.fn(async () => undefined), publishRuntimeEvents: vi.fn(async () => undefined), operatingRuntime: { initialize, applyTransition } as unknown as OperatingRuntime };
      const monitor = new EconomySchedulerMonitor(EPOCH);
      await runEconomySchedulerCycle(db, instant(2 * PERIOD + DAY), adapters, monitor);
      const closed = (await loadEconomyWorldState(db, WORLD))!;
      expect(closed.tenders.get(nextTender.id)).toMatchObject({ phase: "failed", operationStarted: false });
      expect(closed.publicOperations.size).toBe(0);
      expect(closed.contracts.get(first.id)?.operatorId).toBe("operator");
      await runEconomySchedulerCycle(db, instant(3 * PERIOD - 1), adapters, monitor);
      expect(applyTransition).not.toHaveBeenCalled();
      await expect(runEconomySchedulerCycle(db, instant(3 * PERIOD), adapters, monitor)).rejects.toThrow("Runtime nicht bereit");
      expect(encodeEconomyValue(await loadEconomyWorldState(db, WORLD))).toEqual(encodeEconomyValue(closed));
      nativeFailure = false;
      await runEconomySchedulerCycle(db, instant(3 * PERIOD), adapters, monitor);
      const changed = (await loadEconomyWorldState(db, WORLD))!;
      expect(changed.tenders.get(nextTender.id)).toMatchObject({ phase: "failed", operationStarted: true });
      expect(changed.publicOperations.has(first.lotId)).toBe(true);
      expect(changed.operatingRuntimeByLot.get(first.lotId)?.state.revision).toBe(2);
      expect(changed.prequalifications).toEqual(closed.prequalifications);
      expect(adapters.postJournal).not.toHaveBeenCalled();
      expect(adapters.publishRuntimeEvents).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ eventType: "train-operation-assigned", atS: 3 * PERIOD })]));
      const published = adapters.publishRuntimeEvents.mock.calls.length;
      expect((await runEconomySchedulerCycle(db, instant(3 * PERIOD), adapters, monitor)).transitions).toBe(0);
      expect(adapters.publishRuntimeEvents).toHaveBeenCalledTimes(published);
      expect(initialize).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  }, 30_000);

  it("begrenzt das Nachholen in unbefristeten Welten und setzt beim naechsten Lauf fort", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await db.insert(worlds).values({ id: WORLD, name: "Langer Ausfall", schedulePeriodWeeks: 8, epoch: instant(0) });
      await persistEconomyTransition(db, { expectedRevision: null, ...start(1, "unlimited"), committedAt: instant(0), enqueuedAt: instant(0) });
      const adapters = { sendNotice: vi.fn(async () => undefined), postJournal: vi.fn(async () => undefined), publishRuntimeEvents: vi.fn(async () => undefined), operatingRuntime: {} as OperatingRuntime };
      const future = instant(500 * 56 * DAY);
      await runEconomySchedulerCycle(db, future, adapters, new EconomySchedulerMonitor(EPOCH));
      const first = (await loadEconomyWorldState(db, WORLD))!;
      expect(first.tenders.size).toBeGreaterThan(1);
      expect(first.tenders.size).toBeLessThan(250);
      await runEconomySchedulerCycle(db, future, adapters, new EconomySchedulerMonitor(EPOCH));
      expect((await loadEconomyWorldState(db, WORLD))!.tenders.size).toBeGreaterThan(first.tenders.size);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("uebergibt beim Betriebswechsel die Fahrtkennung des erzeugten Spielplans an den Runtime", async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await db.insert(worlds).values({ id: WORLD, name: "Fahrtidentitaet", schedulePeriodWeeks: 3, epoch: instant(0) });
      const started = start(1);
      const tender = [...started.state.tenders.values()][0]!.tender;
      const initial: EconomyWorldState = {
        ...started.state,
        tenders: new Map([[tender.id, { phase: "awarded", tender, bids: [], winningBid: { id: "bid", operatorId: "winner" } as never }]]),
        mobilizations: new Map([[tender.id, { tenderId: tender.id, winnerOperatorId: "winner", deadline: PERIOD, completed: false }]]),
        tenderAutomation: new Map([[tender.id, { ...started.state.tenderAutomation.get(tender.id)!, recipientByOperator: { winner: "founder" } }]]),
      };
      await persistEconomyTransition(db, { expectedRevision: null, state: initial, effects: started.effects, committedAt: instant(0), enqueuedAt: instant(0) });
      const initialize = vi.fn(() => { throw new Error("Runtime-Testgrenze erreicht"); });
      const adapters = { sendNotice: vi.fn(async () => undefined), postJournal: vi.fn(async () => undefined), publishRuntimeEvents: vi.fn(async () => undefined), operatingRuntime: { initialize } as unknown as OperatingRuntime };
      await expect(runEconomySchedulerCycle(db, instant(PERIOD), adapters, new EconomySchedulerMonitor(EPOCH))).rejects.toThrow("Runtime-Testgrenze erreicht");
      expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ lots: [expect.objectContaining({ trainRuns: [{ trainRunId: "game-run-0", formationId: null }] })] }));
      expect((await loadEconomyWorldState(db, WORLD))!.revision).toBe(0);
    } finally {
      await client.close();
    }
  }, 30_000);
});
