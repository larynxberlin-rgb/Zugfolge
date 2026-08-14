import type { HealthCheck } from "@zugfolge/health";

import type { PrometheusMetricSource } from "./observability.js";

export interface RegionalSimulationSchedulerSnapshot {
  readonly startedAtMs: number;
  readonly running: boolean;
  readonly lastStartedAtMs?: number;
  readonly lastCompletedAtMs?: number;
  readonly lastSuccessfulAtMs?: number;
  readonly lastFailureAtMs?: number;
  readonly consecutiveFailures: number;
  readonly successfulCycles: number;
  readonly failedCycles: number;
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
    };
  }

  started(atMs: number): void {
    this.#snapshot = { ...this.#snapshot, lastStartedAtMs: atMs, running: true };
  }

  completed(atMs: number): void {
    this.#snapshot = {
      ...this.#snapshot,
      running: false,
      lastCompletedAtMs: atMs,
      lastSuccessfulAtMs: atMs,
      consecutiveFailures: 0,
      successfulCycles: this.#snapshot.successfulCycles + 1,
    };
  }

  failed(atMs: number): void {
    this.#snapshot = {
      ...this.#snapshot,
      running: false,
      lastCompletedAtMs: atMs,
      lastFailureAtMs: atMs,
      consecutiveFailures: this.#snapshot.consecutiveFailures + 1,
      failedCycles: this.#snapshot.failedCycles + 1,
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
    return lines;
  }
}

export function createRegionalSimulationSchedulerHealthCheck(
  monitor: RegionalSimulationSchedulerMonitor,
  intervalMs = 60_000,
  now: () => number = Date.now,
): HealthCheck {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("Scheduler-Intervall ist ungueltig.");
  const stalledAfterMs = intervalMs * 2;
  return {
    name: "regional-simulation-scheduler",
    async check() {
      const current = monitor.snapshot();
      const atMs = now();
      if (
        current.running
        && current.lastStartedAtMs !== undefined
        && atMs - current.lastStartedAtMs > stalledAfterMs
      ) {
        return { status: "down", code: "scheduler_stalled", detail: "Regionaler Takt wurde nicht abgeschlossen" };
      }
      if (current.consecutiveFailures >= 2) {
        return { status: "down", code: "scheduler_stalled", detail: "Regionaler Takt ist wiederholt fehlgeschlagen" };
      }
      if (current.consecutiveFailures === 1) {
        return { status: "degraded", code: "scheduler_last_cycle_failed", detail: "Letzter regionaler Takt ist fehlgeschlagen" };
      }
      const reference = current.lastSuccessfulAtMs ?? current.startedAtMs;
      if (atMs - reference > stalledAfterMs) {
        return { status: "down", code: "scheduler_stalled", detail: "Kein aktueller erfolgreicher Regionaltakt" };
      }
      if (current.lastSuccessfulAtMs === undefined) {
        return { status: "degraded", code: "scheduler_starting" };
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
