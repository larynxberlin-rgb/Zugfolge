import type { HealthCheck } from "@zugfolge/health";

import type { PrometheusMetricSource } from "./observability.js";

export const REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS = 60_000;
export const LIVEMAP_FRESHNESS_MAXIMUM_AGE_MS = REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS * 2;

export interface RegionalSimulationSchedulerSnapshot {
  readonly startedAtMs: number;
  readonly running: boolean;
  readonly lastStartedAtMs?: number;
  /** Letzter interner Phasenfortschritt, ohne Welt-/Regionslabels. */
  readonly lastProgressAtMs?: number;
  readonly lastCompletedAtMs?: number;
  readonly lastSuccessfulAtMs?: number;
  readonly lastFailureAtMs?: number;
  readonly consecutiveFailures: number;
  readonly successfulCycles: number;
  readonly failedCycles: number;
  readonly skippedCycles: number;
  readonly lastDurationMs?: number;
  readonly maximumDurationMs: number;
}

export interface RegionalSimulationHealthRegion {
  readonly worldId: string;
  readonly regionId: string;
  readonly initializationHash: string;
}

function regionalHealthKey(region: RegionalSimulationHealthRegion): string {
  return `${region.worldId}\u0000${region.regionId}`;
}

/**
 * Prozesslokaler Monitor fuer den autoritativen 1:1-Takt. Fachkennungen
 * bleiben absichtlich ausserhalb dieses Zustands, damit Health und Metriken
 * nur begrenzte Labelmengen veroeffentlichen.
 */
export class RegionalSimulationSchedulerMonitor implements PrometheusMetricSource {
  #snapshot: RegionalSimulationSchedulerSnapshot;

  constructor(
    startedAtMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(startedAtMs)) throw new RangeError("Scheduler-Startzeit ist ungueltig.");
    this.#snapshot = {
      startedAtMs,
      running: false,
      consecutiveFailures: 0,
      successfulCycles: 0,
      failedCycles: 0,
      skippedCycles: 0,
      maximumDurationMs: 0,
    };
  }

  started(atMs: number): void {
    this.#snapshot = {
      ...this.#snapshot,
      lastStartedAtMs: atMs,
      lastProgressAtMs: atMs,
      running: true,
    };
  }

  progress(atMs: number): void {
    if (!Number.isFinite(atMs)) throw new RangeError("Scheduler-Fortschrittszeit ist ungueltig.");
    if (!this.#snapshot.running) return;
    this.#snapshot = { ...this.#snapshot, lastProgressAtMs: atMs };
  }

  completed(atMs: number): void {
    const durationMs = Math.max(0, atMs - (this.#snapshot.lastStartedAtMs ?? atMs));
    this.#snapshot = {
      ...this.#snapshot,
      running: false,
      lastCompletedAtMs: atMs,
      lastSuccessfulAtMs: atMs,
      consecutiveFailures: 0,
      successfulCycles: this.#snapshot.successfulCycles + 1,
      lastDurationMs: durationMs,
      maximumDurationMs: Math.max(this.#snapshot.maximumDurationMs, durationMs),
    };
  }

  failed(atMs: number): void {
    const durationMs = Math.max(0, atMs - (this.#snapshot.lastStartedAtMs ?? atMs));
    this.#snapshot = {
      ...this.#snapshot,
      running: false,
      lastCompletedAtMs: atMs,
      lastFailureAtMs: atMs,
      consecutiveFailures: this.#snapshot.consecutiveFailures + 1,
      failedCycles: this.#snapshot.failedCycles + 1,
      lastDurationMs: durationMs,
      maximumDurationMs: Math.max(this.#snapshot.maximumDurationMs, durationMs),
    };
  }

  skipped(): void {
    this.#snapshot = {
      ...this.#snapshot,
      skippedCycles: this.#snapshot.skippedCycles + 1,
    };
  }

  snapshot(): RegionalSimulationSchedulerSnapshot {
    return Object.freeze({ ...this.#snapshot });
  }

  renderPrometheus(): readonly string[] {
    const current = this.snapshot();
    const lines = [
      "# HELP zugfolge_regional_simulation_scheduler_cycles_total Completed regional scheduler cycles by outcome.",
      "# TYPE zugfolge_regional_simulation_scheduler_cycles_total counter",
      `zugfolge_regional_simulation_scheduler_cycles_total{outcome="success"} ${current.successfulCycles}`,
      `zugfolge_regional_simulation_scheduler_cycles_total{outcome="failure"} ${current.failedCycles}`,
      `zugfolge_regional_simulation_scheduler_cycles_total{outcome="skipped"} ${current.skippedCycles}`,
      "# HELP zugfolge_regional_simulation_scheduler_consecutive_failures Current consecutive failures.",
      "# TYPE zugfolge_regional_simulation_scheduler_consecutive_failures gauge",
      `zugfolge_regional_simulation_scheduler_consecutive_failures ${current.consecutiveFailures}`,
      "# HELP zugfolge_regional_simulation_scheduler_last_success_age_seconds Age of the last successful cycle.",
      "# TYPE zugfolge_regional_simulation_scheduler_last_success_age_seconds gauge",
    ];
    if (current.lastSuccessfulAtMs !== undefined) {
      lines.push(
        `zugfolge_regional_simulation_scheduler_last_success_age_seconds ${Math.max(0, this.now() - current.lastSuccessfulAtMs) / 1_000}`,
      );
    }
    lines.push(
      "# HELP zugfolge_regional_simulation_scheduler_running Whether a regional scheduler cycle is active.",
      "# TYPE zugfolge_regional_simulation_scheduler_running gauge",
      `zugfolge_regional_simulation_scheduler_running ${current.running ? 1 : 0}`,
      "# HELP zugfolge_regional_simulation_scheduler_progress_age_seconds Age of the last internal progress phase while a cycle is active.",
      "# TYPE zugfolge_regional_simulation_scheduler_progress_age_seconds gauge",
      `zugfolge_regional_simulation_scheduler_progress_age_seconds ${current.running && current.lastProgressAtMs !== undefined
        ? Math.max(0, this.now() - current.lastProgressAtMs) / 1_000
        : 0}`,
    );
    lines.push(
      "# HELP zugfolge_regional_simulation_scheduler_last_duration_seconds Duration of the last completed regional scheduler cycle.",
      "# TYPE zugfolge_regional_simulation_scheduler_last_duration_seconds gauge",
      `zugfolge_regional_simulation_scheduler_last_duration_seconds ${(current.lastDurationMs ?? 0) / 1_000}`,
      "# HELP zugfolge_regional_simulation_scheduler_maximum_duration_seconds Maximum completed regional scheduler cycle duration since process start.",
      "# TYPE zugfolge_regional_simulation_scheduler_maximum_duration_seconds gauge",
      `zugfolge_regional_simulation_scheduler_maximum_duration_seconds ${current.maximumDurationMs / 1_000}`,
    );
    return lines;
  }
}

export function createRegionalSimulationSchedulerHealthCheck(
  monitor: RegionalSimulationSchedulerMonitor,
  intervalMs = REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS,
  now: () => number = Date.now,
  expectedRegions?: () => readonly RegionalSimulationHealthRegion[],
  readyRegions?: () => readonly RegionalSimulationHealthRegion[],
): HealthCheck {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("Scheduler-Intervall ist ungueltig.");
  if ((expectedRegions === undefined) !== (readyRegions === undefined)) {
    throw new TypeError("Scheduler-Readiness braucht erwartete und gestartete Regionen gemeinsam.");
  }
  const stalledAfterMs = intervalMs * 2;
  return {
    name: "regional-simulation-scheduler",
    async check() {
      const current = monitor.snapshot();
      const atMs = now();
      if (expectedRegions !== undefined && readyRegions !== undefined) {
        const expected = [...new Map(expectedRegions().map((region) => [
          regionalHealthKey(region),
          region,
        ] as const)).values()];
        const ready = new Map(readyRegions().map((region) => [regionalHealthKey(region), region] as const));
        const missing = expected.filter((region) => {
          const actual = ready.get(regionalHealthKey(region));
          return actual?.initializationHash !== region.initializationHash;
        });
        if (missing.length > 0) {
          return {
            status: "down",
            code: "scheduler_regions_missing",
            detail: `${missing.length}/${expected.length} erwartete Echtzeitregionen sind nicht bereit`,
          };
        }
      }
      const lastProgressAtMs = current.lastProgressAtMs ?? current.lastStartedAtMs;
      if (
        current.running
        && lastProgressAtMs !== undefined
        && atMs - lastProgressAtMs > stalledAfterMs
      ) {
        return { status: "down", code: "scheduler_stalled", detail: "Regionaler Takt wurde nicht abgeschlossen" };
      }
      if (current.consecutiveFailures >= 2) {
        return { status: "down", code: "scheduler_stalled", detail: "Regionaler Takt ist wiederholt fehlgeschlagen" };
      }
      if (current.consecutiveFailures === 1) {
        return { status: "degraded", code: "scheduler_last_cycle_failed", detail: "Letzter regionaler Takt ist fehlgeschlagen" };
      }
      if (current.lastSuccessfulAtMs === undefined) {
        if (current.running) {
          return {
            status: "down",
            code: "scheduler_catching_up",
            detail: "Erster autoritativer Regionaltakt laeuft",
          };
        }
        if (atMs - current.startedAtMs > stalledAfterMs) {
          return { status: "down", code: "scheduler_stalled", detail: "Erster Regionaltakt wurde nicht gestartet" };
        }
        return {
          status: "down",
          code: "scheduler_starting",
          detail: "Erster autoritativer Regionaltakt wurde noch nicht abgeschlossen",
        };
      }
      if (atMs - current.lastSuccessfulAtMs > stalledAfterMs) {
        return { status: "down", code: "scheduler_stalled", detail: "Kein aktueller erfolgreicher Regionaltakt" };
      }
      return { status: "ok", code: "scheduler_current" };
    },
  };
}

export async function runMonitoredRegionalSimulationCycle<T>(
  monitor: RegionalSimulationSchedulerMonitor,
  at: Date,
  run: () => Promise<T>,
  completedAt: () => number = Date.now,
): Promise<T> {
  const atMs = at.getTime();
  if (Number.isNaN(atMs)) throw new RangeError("Scheduler-Laufzeitpunkt ist ungueltig.");
  monitor.started(atMs);
  try {
    const result = await run();
    monitor.completed(completedAt());
    return result;
  } catch (error) {
    monitor.failed(completedAt());
    throw error;
  }
}
