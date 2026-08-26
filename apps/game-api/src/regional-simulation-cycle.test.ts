import { describe, expect, it, vi } from "vitest";

import {
  RegionalSimulationCycleCoordinator,
  regionalSimulationStartupRouteAllowed,
  type RegionalSimulationStructuredLogger,
} from "./regional-simulation-cycle.js";
import {
  createRegionalSimulationSchedulerHealthCheck,
  RegionalSimulationSchedulerMonitor,
} from "./regional-simulation-monitor.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function logger(): RegionalSimulationStructuredLogger & {
  readonly records: Array<Readonly<Record<string, unknown>>>;
} {
  const records: Array<Readonly<Record<string, unknown>>> = [];
  const write = (bindings: Readonly<Record<string, unknown>>) => { records.push(bindings); };
  return {
    records,
    debug: write,
    info: write,
    warn: write,
    error: write,
  };
}

describe("RegionalSimulationCycleCoordinator", () => {
  it("laesst vor dem ersten Catch-up nur Liveness, Readiness und Metriken passieren", () => {
    expect(regionalSimulationStartupRouteAllowed("/health")).toBe(true);
    expect(regionalSimulationStartupRouteAllowed("/health/ready?probe=1")).toBe(true);
    expect(regionalSimulationStartupRouteAllowed("/metrics")).toBe(true);
    expect(regionalSimulationStartupRouteAllowed("/worlds/public/livemap")).toBe(false);
    expect(regionalSimulationStartupRouteAllowed("/integrations/odoo/webhooks")).toBe(false);
  });

  it("korreliert einen intermittierenden Stillstand, ueberspringt ueberlappende Intervalle und erholt sich", async () => {
    let now = 1_000;
    let watchdog: (() => void) | undefined;
    const pending = deferred<number>();
    const log = logger();
    const monitor = new RegionalSimulationSchedulerMonitor(now, () => now);
    monitor.started(now);
    monitor.completed(now);
    const health = createRegionalSimulationSchedulerHealthCheck(monitor, 60_000, () => now);
    const coordinator = new RegionalSimulationCycleCoordinator({
      monitor,
      logger: log,
      now: () => now,
      schedule: (callback) => {
        watchdog = callback;
        return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: vi.fn(),
      run: async ({ reportProgress }) => {
        reportProgress({
          phase: "batch-started",
          worldId: "internal-world",
          regionId: "internal-region",
          currentNowMs: 0,
          targetNowMs: 60_000,
          commandCount: 1,
        });
        return pending.promise;
      },
    });

    const first = coordinator.run(new Date(now));
    await Promise.resolve();
    now += 60_000;
    await expect(coordinator.run(new Date(now))).resolves.toMatchObject({
      status: "skipped",
      skippedIntervals: 1,
    });
    await expect(health.check()).resolves.toMatchObject({ status: "ok", code: "scheduler_current" });

    now += 60_001;
    watchdog?.();
    await expect(health.check()).resolves.toMatchObject({ status: "down", code: "scheduler_stalled" });
    const stalled = log.records.find((record) => record["event"] === "regional_scheduler_cycle_stalled");
    expect(stalled).toMatchObject({
      correlationId: "regional-scheduler:1000:1",
      lastProgress: expect.objectContaining({
        worldId: "internal-world",
        regionId: "internal-region",
        phase: "batch-started",
      }),
    });
    expect(JSON.stringify(await health.check())).not.toContain("internal-world");
    expect(JSON.stringify(await health.check())).not.toContain("internal-region");

    pending.resolve(1);
    await expect(first).resolves.toMatchObject({
      status: "completed",
      advancedRegions: 1,
      skippedIntervals: 1,
    });
    await expect(health.check()).resolves.toMatchObject({ status: "ok", code: "scheduler_current" });
    expect(log.records).toContainEqual(expect.objectContaining({
      event: "regional_scheduler_cycle_recovered",
      correlationId: "regional-scheduler:1000:1",
    }));
    expect(monitor.snapshot()).toMatchObject({ successfulCycles: 2, skippedCycles: 1 });
  });

  it("protokolliert einen erzwungenen Fehler mit Korrelation und haelt Healthdetails fachkennungsfrei", async () => {
    const now = 5_000;
    const log = logger();
    const monitor = new RegionalSimulationSchedulerMonitor(now, () => now);
    const coordinator = new RegionalSimulationCycleCoordinator({
      monitor,
      logger: log,
      now: () => now,
      schedule: () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>,
      cancel: vi.fn(),
      run: async ({ reportProgress }) => {
        reportProgress({
          phase: "region-failed",
          worldId: "private-world",
          regionId: "private-region",
        });
        throw new Error("erzwungener Schedulerfehler");
      },
    });

    await expect(coordinator.run(new Date(now))).rejects.toThrow("erzwungener Schedulerfehler");
    const failed = log.records.find((record) => record["event"] === "regional_scheduler_cycle_failed");
    expect(failed).toMatchObject({
      correlationId: "regional-scheduler:5000:1",
      lastProgress: expect.objectContaining({
        worldId: "private-world",
        regionId: "private-region",
      }),
      err: expect.any(Error),
    });
    const publicHealth = await createRegionalSimulationSchedulerHealthCheck(
      monitor,
      60_000,
      () => now,
    ).check();
    expect(publicHealth).toMatchObject({ status: "degraded", code: "scheduler_last_cycle_failed" });
    expect(JSON.stringify(publicHealth)).not.toContain("private-world");
    expect(JSON.stringify(publicHealth)).not.toContain("private-region");
  });

  it("wartet beim Shutdown auf den aktiven Lauf ohne dessen bereits protokollierten Fehler erneut zu werfen", async () => {
    const pending = deferred<number>();
    const coordinator = new RegionalSimulationCycleCoordinator({
      monitor: new RegionalSimulationSchedulerMonitor(1_000, () => 1_000),
      logger: logger(),
      now: () => 1_000,
      schedule: () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>,
      cancel: vi.fn(),
      run: async () => pending.promise,
    });

    const cycle = coordinator.run(new Date(1_000));
    const closing = coordinator.close();
    pending.reject(new Error("shutdown-cycle-failed"));

    await expect(cycle).rejects.toThrow("shutdown-cycle-failed");
    await expect(closing).resolves.toBeUndefined();
  });
});
