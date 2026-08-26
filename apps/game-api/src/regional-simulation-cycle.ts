import {
  REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS,
  type RegionalSimulationSchedulerMonitor,
  runMonitoredRegionalSimulationCycle,
} from "./regional-simulation-monitor.js";
import type { RegionalSimulationSchedulerProgress } from "./regional-simulation-scheduler.js";

export interface RegionalSimulationStructuredLogger {
  debug(bindings: Readonly<Record<string, unknown>>, message: string): void;
  info(bindings: Readonly<Record<string, unknown>>, message: string): void;
  warn(bindings: Readonly<Record<string, unknown>>, message: string): void;
  error(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

export interface RegionalSimulationCycleContext {
  readonly at: Date;
  readonly correlationId: string;
  reportProgress(progress: RegionalSimulationSchedulerProgress): void;
}

export type RegionalSimulationCycleOperation = (
  context: RegionalSimulationCycleContext,
) => Promise<number>;

export type RegionalSimulationCycleResult =
  | Readonly<{
      status: "completed";
      correlationId: string;
      advancedRegions: number;
      durationMs: number;
      skippedIntervals: number;
    }>
  | Readonly<{
      status: "skipped";
      correlationId: string;
      runningForMs: number;
      skippedIntervals: number;
    }>;

interface ActiveCycle {
  readonly correlationId: string;
  readonly startedAtMs: number;
  skippedIntervals: number;
  stalled: boolean;
  lastProgress?: RegionalSimulationSchedulerProgress;
  watchdog?: ReturnType<typeof setTimeout>;
  promise?: Promise<RegionalSimulationCycleResult>;
}

export interface RegionalSimulationCycleCoordinatorOptions {
  readonly monitor: RegionalSimulationSchedulerMonitor;
  readonly run: RegionalSimulationCycleOperation;
  readonly logger: RegionalSimulationStructuredLogger;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly schedule?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Waehrend des ersten Cold-Catch-ups bleiben nur Liveness, Readiness und
 * bereits materialisierte Metriken erreichbar. Fachrouten duerfen keinen
 * restaurierten, aber noch nicht auf die Plattformzeit nachgezogenen Stand
 * ausliefern.
 */
export function regionalSimulationStartupRouteAllowed(url: string): boolean {
  const path = url.split(/[?#]/u, 1)[0];
  return path === "/health" || path === "/health/ready" || path === "/metrics";
}

function logSafely(
  logger: RegionalSimulationStructuredLogger,
  level: keyof RegionalSimulationStructuredLogger,
  bindings: Readonly<Record<string, unknown>>,
  message: string,
): void {
  try {
    logger[level](bindings, message);
  } catch {
    // Diagnoseausgabe darf weder Schedulerzustand noch Commitpfad beeinflussen.
  }
}

/**
 * Ueberlappungsfreier Plattformtakt mit internem Korrelations- und
 * Phasenwatchdog. Oeffentliche Healthdetails bleiben beim Monitor bewusst frei
 * von Welt- oder Regionskennungen.
 */
export class RegionalSimulationCycleCoordinator {
  readonly #monitor: RegionalSimulationSchedulerMonitor;
  readonly #run: RegionalSimulationCycleOperation;
  readonly #logger: RegionalSimulationStructuredLogger;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #schedule: NonNullable<RegionalSimulationCycleCoordinatorOptions["schedule"]>;
  readonly #cancel: NonNullable<RegionalSimulationCycleCoordinatorOptions["cancel"]>;
  #active: ActiveCycle | undefined;
  #sequence = 0;

  constructor(options: RegionalSimulationCycleCoordinatorOptions) {
    const intervalMs = options.intervalMs ?? REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError("Scheduler-Intervall ist ungueltig.");
    }
    this.#monitor = options.monitor;
    this.#run = options.run;
    this.#logger = options.logger;
    this.#intervalMs = intervalMs;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancel = options.cancel ?? clearTimeout;
  }

  run(at: Date): Promise<RegionalSimulationCycleResult> {
    const atMs = at.getTime();
    if (Number.isNaN(atMs)) throw new RangeError("Scheduler-Laufzeitpunkt ist ungueltig.");
    const active = this.#active;
    if (active !== undefined) {
      active.skippedIntervals += 1;
      this.#monitor.skipped();
      const runningForMs = Math.max(0, this.#now() - active.startedAtMs);
      logSafely(this.#logger, "warn", {
        event: "regional_scheduler_cycle_skipped",
        correlationId: active.correlationId,
        runningForMs,
        skippedIntervals: active.skippedIntervals,
        ...(active.lastProgress === undefined ? {} : { lastProgress: active.lastProgress }),
      }, "Regionaler 1:1-Takt laeuft beim naechsten Intervall noch");
      return Promise.resolve({
        status: "skipped",
        correlationId: active.correlationId,
        runningForMs,
        skippedIntervals: active.skippedIntervals,
      });
    }

    const correlationId = `regional-scheduler:${atMs}:${++this.#sequence}`;
    const cycle: ActiveCycle = {
      correlationId,
      startedAtMs: atMs,
      skippedIntervals: 0,
      stalled: false,
    };
    this.#active = cycle;
    logSafely(this.#logger, "debug", {
      event: "regional_scheduler_cycle_started",
      correlationId,
      scheduledAt: at.toISOString(),
    }, "Regionaler 1:1-Takt gestartet");

    const armWatchdog = () => {
      if (cycle.watchdog !== undefined) this.#cancel(cycle.watchdog);
      cycle.watchdog = this.#schedule(() => {
        if (this.#active !== cycle) return;
        cycle.stalled = true;
        logSafely(this.#logger, "error", {
          event: "regional_scheduler_cycle_stalled",
          correlationId,
          runningForMs: Math.max(0, this.#now() - cycle.startedAtMs),
          skippedIntervals: cycle.skippedIntervals,
          ...(cycle.lastProgress === undefined ? {} : { lastProgress: cycle.lastProgress }),
        }, "Regionaler 1:1-Takt hat die Stillstandsgrenze ueberschritten");
      }, this.#intervalMs * 2);
      cycle.watchdog.unref?.();
    };
    armWatchdog();

    const promise = runMonitoredRegionalSimulationCycle(
      this.#monitor,
      at,
      () => this.#run({
        at,
        correlationId,
        reportProgress: (progress) => {
          if (this.#active !== cycle) return;
          cycle.lastProgress = progress;
          this.#monitor.progress(this.#now());
          armWatchdog();
          logSafely(this.#logger, "debug", {
            event: "regional_scheduler_cycle_progress",
            correlationId,
            progress,
          }, "Regionaler 1:1-Takt hat eine interne Phase erreicht");
        },
      }),
      this.#now,
    ).then((advancedRegions): RegionalSimulationCycleResult => {
      const durationMs = Math.max(0, this.#now() - cycle.startedAtMs);
      logSafely(this.#logger, cycle.stalled ? "info" : "debug", {
        event: cycle.stalled
          ? "regional_scheduler_cycle_recovered"
          : "regional_scheduler_cycle_completed",
        correlationId,
        durationMs,
        skippedIntervals: cycle.skippedIntervals,
        advancedRegions,
        ...(cycle.lastProgress === undefined ? {} : { lastProgress: cycle.lastProgress }),
      }, cycle.stalled
        ? "Regionaler 1:1-Takt hat sich nach Stillstand kontrolliert erholt"
        : "Regionaler 1:1-Takt abgeschlossen");
      return {
        status: "completed",
        correlationId,
        advancedRegions,
        durationMs,
        skippedIntervals: cycle.skippedIntervals,
      };
    }).catch((error: unknown) => {
      logSafely(this.#logger, "error", {
        event: "regional_scheduler_cycle_failed",
        correlationId,
        durationMs: Math.max(0, this.#now() - cycle.startedAtMs),
        skippedIntervals: cycle.skippedIntervals,
        err: error,
        ...(cycle.lastProgress === undefined ? {} : { lastProgress: cycle.lastProgress }),
      }, "Regionaler 1:1-Takt fehlgeschlagen");
      throw error;
    }).finally(() => {
      if (cycle.watchdog !== undefined) this.#cancel(cycle.watchdog);
      if (this.#active === cycle) this.#active = undefined;
    });
    cycle.promise = promise;
    return promise;
  }

  async close(): Promise<void> {
    try {
      await this.#active?.promise;
    } catch {
      // Der Zyklusfehler wurde bereits korreliert protokolliert und vom Monitor
      // erfasst. Ein spaeter Server-Shutdown darf ihn nicht erneut propagieren.
    }
  }
}
