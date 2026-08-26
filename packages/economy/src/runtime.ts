import type { HealthCheck } from "@zugfolge/health";
import { alphaWorldProfiles } from "@zugfolge/db";
import {
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  type OperatingRuntime,
  type OperatingTransitionResult,
} from "@zugfolge/runtime-native";

import type { EconomyDatabase } from "./ledger.js";
import type { MobilizationProof } from "./contracts.js";
import {
  loadFleetMobilizationSnapshot,
  PUBLIC_ENTRY_FACILITY_SCHEMA,
  verifyMobilizationReference,
  verifyPublicEntryFacilityMobilizationReference,
} from "./fleet-snapshot.js";
import { eq } from "drizzle-orm";
import { compareUtf8 } from "./utf8.js";
import {
  dispatchEconomyOutbox,
  decodeEconomyValue,
  EconomyStateConflictError,
  listEconomyWorldIds,
  listPendingEconomyOutboxWorldIds,
  loadEconomyWorldEpoch,
  loadEconomyWorldState,
  persistEconomyTransition,
} from "./state-store.js";
import {
  closeTender,
  completeMobilization,
  openTender,
  type EconomyEffects,
  type EconomyJournalEntry,
  type EconomyNotice,
  type TenderLifecycle,
  type EconomyWorldState,
} from "./workflow.js";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

async function assertSignedEntryFacilityReference(
  db: EconomyDatabase,
  worldId: string,
  lotId: string,
): Promise<{
  readonly providerOperatorId: "public";
  readonly signedLotVehicleIds: readonly string[];
  readonly signedLotPersonnelDutyIds: readonly string[];
  readonly signedLotPathReceiptIds: readonly string[];
}> {
  const [profile] = await db.select({
    blueprint: alphaWorldProfiles.blueprint,
    blueprintHash: alphaWorldProfiles.blueprintHash,
    deploymentHash: alphaWorldProfiles.deploymentHash,
    state: alphaWorldProfiles.state,
  }).from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
  const blueprint = record(decodeEconomyValue(profile?.blueprint));
  const policy = record(blueprint?.["entryFacilityPolicy"]);
  if (
    profile?.state !== "running"
    || !/^[a-f0-9]{64}$/.test(profile.blueprintHash)
    || profile.deploymentHash === null
    || !/^[a-f0-9]{64}$/.test(profile.deploymentHash)
    || policy?.["schemaVersion"] !== PUBLIC_ENTRY_FACILITY_SCHEMA
    || policy["mode"] !== "award-contingent-wet-lease"
    || policy["providerOperatorId"] !== "public"
    || policy["costBasis"] !== "formation-operating-cost"
  ) throw new Error("Persistierte Welt besitzt keinen signierten Anschubvertrag.");
  const lots = blueprint?.["lots"];
  const lot = Array.isArray(lots)
    ? lots.map((item) => record(item)).find((item) => item?.["lotId"] === lotId)
    : undefined;
  if (lot === undefined) throw new Error("Anschubvertrag verweist nicht auf ein signiertes Los.");
  const signedValues = (key: "vehicleIds" | "personnelDutyIds" | "pathReceiptIds") =>
    Array.isArray(lot[key]) ? lot[key].map((value) => typeof value === "string" ? value : "") : [];
  return {
    providerOperatorId: "public",
    signedLotVehicleIds: signedValues("vehicleIds"),
    signedLotPersonnelDutyIds: signedValues("personnelDutyIds"),
    signedLotPathReceiptIds: signedValues("pathReceiptIds"),
  };
}

export interface EconomyEffectAdapters {
  readonly postJournal: (entry: EconomyJournalEntry) => Promise<void>;
  readonly sendNotice: (notice: EconomyNotice) => Promise<void>;
  readonly operatingRuntime: OperatingRuntime;
  /** Publishes already committed Rust events into in-memory projections. */
  readonly publishRuntimeEvents: (events: readonly NonNullable<EconomyEffects["runtimeEvents"]>[number][]) => Promise<void>;
}

export interface EconomySchedulerSnapshot {
  readonly startedAtMs: number;
  readonly lastStartedAtMs?: number;
  readonly lastCompletedAtMs?: number;
  readonly lastFailureAtMs?: number;
  readonly lastFailureCode?: string;
  readonly running: boolean;
  readonly processedTransitions: number;
}

export class EconomySchedulerMonitor {
  #snapshot: EconomySchedulerSnapshot;

  constructor(startedAtMs: number) {
    this.#snapshot = { startedAtMs, running: false, processedTransitions: 0 };
  }

  started(atMs: number): void {
    this.#snapshot = { ...this.#snapshot, lastStartedAtMs: atMs, running: true };
  }

  completed(atMs: number, processedTransitions: number): void {
    this.#snapshot = {
      ...this.#snapshot,
      lastCompletedAtMs: atMs,
      running: false,
      processedTransitions: this.#snapshot.processedTransitions + processedTransitions,
    };
  }

  failed(atMs: number, error: unknown): void {
    this.#snapshot = {
      ...this.#snapshot,
      lastFailureAtMs: atMs,
      lastFailureCode: error instanceof Error ? error.name : "scheduler_failed",
      running: false,
    };
  }

  snapshot(): EconomySchedulerSnapshot {
    return Object.freeze({ ...this.#snapshot });
  }
}

export function createEconomySchedulerHealthCheck(
  monitor: EconomySchedulerMonitor,
  maximumLagMs = 30_000,
  now: () => number = Date.now,
): HealthCheck {
  return {
    name: "economy-scheduler",
    async check() {
      const current = monitor.snapshot();
      const reference = current.lastCompletedAtMs ?? current.startedAtMs;
      const lagMs = Math.max(0, now() - reference);
      if (current.running && current.lastStartedAtMs !== undefined && now() - current.lastStartedAtMs > maximumLagMs) {
        return { status: "down", code: "scheduler_stuck", detail: `Lauf aktiv seit ${Math.round((now() - current.lastStartedAtMs) / 1_000)} s` };
      }
      if (current.lastFailureAtMs !== undefined && (current.lastCompletedAtMs ?? 0) < current.lastFailureAtMs) {
        return { status: "down", code: "scheduler_failed", detail: `Letzter Fehlercode ${current.lastFailureCode ?? "scheduler_failed"}` };
      }
      if (lagMs > maximumLagMs) {
        return { status: "down", code: "scheduler_lag", detail: `Letzter erfolgreicher Lauf vor ${Math.round(lagMs / 1_000)} s` };
      }
      if (current.lastCompletedAtMs === undefined) return { status: "degraded", code: "scheduler_starting" };
      return { status: "ok", code: "scheduler_current", detail: `${current.processedTransitions} Fristübergänge verarbeitet` };
    },
  };
}

function appendEffects(target: { notices: EconomyNotice[]; journal: EconomyJournalEntry[]; runtimeEvents: NonNullable<EconomyEffects["runtimeEvents"]>[number][] }, effects: EconomyEffects): void {
  target.notices.push(...effects.notices);
  target.journal.push(...effects.journal);
  target.runtimeEvents.push(...(effects.runtimeEvents ?? []));
}

type AwardedTender = Extract<TenderLifecycle, { readonly phase: "awarded" }>;

function trainRunsForLot(
  state: EconomyWorldState,
  current: AwardedTender,
  proof: MobilizationProof | undefined,
): readonly { readonly trainRunId: string; readonly formationId: string | null }[] {
  if (state.planning === undefined) return [];
  const lot = state.planning.snapshot.lots.find((candidate) => candidate.id === current.tender.lotId);
  if (lot === undefined) throw new Error(`GTFS-Planung enthaelt Los '${current.tender.lotId}' nicht.`);
  const patterns = state.planning.snapshot.patterns
    .filter((pattern) => lot.patternIds.includes(pattern.id))
    .sort((left, right) => compareUtf8(left.id, right.id));
  const incumbentFormationId = current.winningBid.operatorId === current.tender.incumbentOperatorId
    ? (proof?.formationIds[0] ?? current.winningBid.vehicle.formationId)
    : null;
  const trainRuns = patterns.flatMap((pattern) => pattern.journeys
    .map((journey) => ({
      trainRunId: `${pattern.id}:${journey.sourceTripId}:${journey.serviceDate}:${journey.departureEpochSeconds}`,
      formationId: incumbentFormationId,
    }))
    .sort((left, right) => compareUtf8(left.trainRunId, right.trainRunId)));
  if (trainRuns.length === 0) throw new Error(`GTFS-Los '${current.tender.lotId}' enthaelt keine Zugfahrt.`);
  return Object.freeze(trainRuns);
}

function applyOperatingTransition(
  runtime: OperatingRuntime,
  state: EconomyWorldState,
  current: AwardedTender,
  proof: MobilizationProof | undefined,
  publicVehiclePool: readonly string[],
  commandId: string,
): OperatingTransitionResult {
  const existing = state.operatingRuntimeByLot.get(current.tender.lotId);
  const initialized = existing ?? runtime.initialize({
    schemaVersion: OPERATING_INITIALIZE_SCHEMA,
    worldId: state.worldId,
    lots: [{
      lotId: current.tender.lotId,
      incumbentOperatorId: current.tender.incumbentOperatorId,
      timetableBoundaryS: current.tender.operatingFrom,
      trainRuns: trainRunsForLot(state, current, proof),
    }],
  });
  return runtime.applyTransition(initialized.state, {
    schemaVersion: OPERATING_TRANSITION_SCHEMA,
    worldId: state.worldId,
    commandId,
    expectedStateHash: initialized.stateHash,
    expectedRevision: initialized.state.revision,
    lotId: current.tender.lotId,
    atS: current.tender.operatingFrom,
    winnerOperatorId: current.winningBid.operatorId,
    mobilizationProof: proof ?? null,
    publicVehiclePool,
  });
}

/**
 * Holt versäumte exakte Fristen deterministisch nach: Das fachliche Kommando
 * trägt stets den veröffentlichten Zeitpunkt, nicht die zufällige Workerzeit.
 */
async function advanceWorld(
  db: EconomyDatabase,
  initial: EconomyWorldState,
  nowSeconds: number,
  operatingRuntime: OperatingRuntime,
): Promise<{ readonly state: EconomyWorldState; readonly effects: EconomyEffects; readonly transitions: number }> {
  if (initial.closed === true) {
    return { state: initial, effects: { notices: [], journal: [], runtimeEvents: [] }, transitions: 0 };
  }
  let state = initial;
  let transitions = 0;
  const effects = { notices: [] as EconomyNotice[], journal: [] as EconomyJournalEntry[], runtimeEvents: [] as NonNullable<EconomyEffects["runtimeEvents"]>[number][] };
  const tenderIds = [...state.tenders.keys()].sort(compareUtf8);
  for (const tenderId of tenderIds) {
    let current = state.tenders.get(tenderId);
    if (current?.phase === "announced" && current.tender.opensAt <= nowSeconds) {
      state = openTender(state, `scheduler:${tenderId}:open:${current.tender.opensAt}`, tenderId, current.tender.opensAt);
      transitions += 1;
      current = state.tenders.get(tenderId);
    }
    if (current?.phase === "open" && current.tender.closesAt <= nowSeconds) {
      const automation = state.tenderAutomation.get(tenderId);
      if (automation === undefined) throw new Error(`Scheduler-Konfiguration für Ausschreibung '${tenderId}' fehlt.`);
      const closed = closeTender(state, {
        commandId: `scheduler:${tenderId}:close:${current.tender.closesAt}`,
        tenderId,
        at: current.tender.closesAt,
        authorityId: automation.authorityId,
        budgetPeriod: automation.budgetPeriod,
        vehiclePool: automation.vehiclePool,
        recipientByOperator: automation.recipientByOperator,
      });
      state = closed.state;
      appendEffects(effects, closed.effects);
      transitions += 1;
      current = state.tenders.get(tenderId);
    }
    const mobilization = state.mobilizations.get(tenderId);
    if (current?.phase === "awarded" && mobilization !== undefined && !mobilization.completed && current.tender.operatingFrom <= nowSeconds) {
      const automation = state.tenderAutomation.get(tenderId);
      if (automation === undefined) throw new Error(`Scheduler-Konfiguration für Mobilisierung '${tenderId}' fehlt.`);
      const recipientAccountId = automation.recipientByOperator[current.winningBid.operatorId];
      if (recipientAccountId === undefined) throw new Error(`Empfängerkonto für EVU '${current.winningBid.operatorId}' fehlt.`);
      let proof;
      if (mobilization.reference !== undefined) {
        try {
          const snapshot = await loadFleetMobilizationSnapshot(db, state.worldId, mobilization.reference);
          const nativeVerification = operatingRuntime.verifyFleetMobilizationSnapshot(snapshot);
          if (
            nativeVerification.worldId !== state.worldId
            || nativeVerification.fleetRevision !== mobilization.reference.fleetRevision
            || nativeVerification.snapshotHash !== mobilization.reference.snapshotHash
          ) {
            throw new Error("Rust-verifizierter M5-Snapshot stimmt nicht mit der persistierten Mobilisierungsreferenz ueberein.");
          }
          if (mobilization.reference.entryFacility === undefined) {
            proof = verifyMobilizationReference(snapshot, mobilization.reference, {
              operatorId: current.winningBid.operatorId,
              winningFormationId: current.winningBid.vehicle.formationId,
              serviceLineIds: current.tender.specification.lines,
              operatingFrom: current.tender.operatingFrom,
            });
          } else {
            const facility = await assertSignedEntryFacilityReference(
              db,
              state.worldId,
              current.tender.lotId,
            );
            proof = verifyPublicEntryFacilityMobilizationReference(snapshot, mobilization.reference, {
              providerOperatorId: facility.providerOperatorId,
              signedLotVehicleIds: facility.signedLotVehicleIds,
              signedLotPersonnelDutyIds: facility.signedLotPersonnelDutyIds,
              signedLotPathReceiptIds: facility.signedLotPathReceiptIds,
              winningFormationId: current.winningBid.vehicle.formationId,
              serviceLineIds: current.tender.specification.lines,
              operatingFrom: current.tender.operatingFrom,
            });
          }
        } catch {
          // Ein fehlender oder inzwischen nicht verifizierbarer Beleg führt
          // deterministisch in den bereits modellierten Eigenbetrieb/Pönale-Pfad.
          proof = undefined;
        }
      }
      const operatingTransition = applyOperatingTransition(
        operatingRuntime,
        state,
        current,
        proof,
        automation.vehiclePool,
        `scheduler:${tenderId}:mobilize:${current.tender.operatingFrom}`,
      );
      const completed = completeMobilization(state, {
        commandId: `scheduler:${tenderId}:mobilize:${current.tender.operatingFrom}`,
        tenderId,
        at: current.tender.operatingFrom,
        proof,
        failurePenaltyCents: automation.failurePenaltyCents,
        recipientAccountId,
        publicVehiclePool: automation.vehiclePool,
        operatingTransition,
      });
      state = completed.state;
      appendEffects(effects, completed.effects);
      transitions += 1;
    }
  }
  return { state, effects, transitions };
}

export async function runEconomySchedulerCycle(
  db: EconomyDatabase,
  now: Date,
  adapters: EconomyEffectAdapters,
  monitor: EconomySchedulerMonitor,
): Promise<{ readonly worlds: number; readonly transitions: number; readonly effects: number }> {
  const startedAtMs = now.getTime();
  monitor.started(startedAtMs);
  let transitions = 0;
  let effects = 0;
  try {
    const worldIds = await listEconomyWorldIds(db);
    for (const worldId of worldIds) {
      const epoch = await loadEconomyWorldEpoch(db, worldId);
      const nowSeconds = Math.floor((now.getTime() - epoch.getTime()) / 1_000);
      if (!Number.isSafeInteger(nowSeconds)) {
        throw new RangeError(`Simulationszeit fuer Welt '${worldId}' liegt ausserhalb sicherer Ganzzahlen.`);
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const initial = await loadEconomyWorldState(db, worldId);
        if (initial === undefined) break;
        const advanced = await advanceWorld(db, initial, nowSeconds, adapters.operatingRuntime);
        if (advanced.transitions === 0) break;
        try {
          await persistEconomyTransition(db, {
            expectedRevision: initial.revision,
            state: advanced.state,
            effects: advanced.effects,
            committedAt: now,
            enqueuedAt: now,
          });
          // The database event log is authoritative. Projection fanout happens
          // only after the state and Rust events committed atomically.
          await adapters.publishRuntimeEvents(advanced.effects.runtimeEvents ?? []);
          transitions += advanced.transitions;
          effects += advanced.effects.journal.length + advanced.effects.notices.length;
          break;
        } catch (error) {
          if (!(error instanceof EconomyStateConflictError) || attempt === 2) throw error;
        }
      }
    }
    // Die Datenbank-Fence verlangt eine leere Outbox vor der Archivierung.
    // Der Scheduler bearbeitet deshalb nur weiterhin schreibbare Welten.
    const pendingOutboxWorldIds = await listPendingEconomyOutboxWorldIds(db);
    const dispatchErrors: unknown[] = [];
    for (const worldId of pendingOutboxWorldIds) {
      try {
        effects += await dispatchEconomyOutbox(db, worldId, adapters, now);
      } catch (error) {
        // Eine defekte Altzeile einer Welt darf die weltisolierte Zustellung
        // anderer Welten nicht verhungern lassen. Der Gesamtzyklus bleibt
        // dennoch fehlgeschlagen und der Monitor meldet ihn sichtbar.
        dispatchErrors.push(error);
      }
    }
    if (dispatchErrors.length > 0) throw dispatchErrors[0];
    monitor.completed(now.getTime(), transitions);
    return { worlds: worldIds.length, transitions, effects };
  } catch (error) {
    monitor.failed(now.getTime(), error);
    throw error;
  }
}
