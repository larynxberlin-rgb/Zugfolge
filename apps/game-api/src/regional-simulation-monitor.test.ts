import { describe, expect, it, vi } from "vitest";
import { createLivemapHealthCheck, LivemapRegistry } from "@zugfolge/livemap-stream";

import {
  createRegionalSimulationSchedulerHealthCheck,
  LIVEMAP_FRESHNESS_MAXIMUM_AGE_MS,
  REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS,
  RegionalSimulationSchedulerMonitor,
  runMonitoredRegionalSimulationCycle,
} from "./regional-simulation-monitor.js";

describe("RegionalSimulationSchedulerMonitor", () => {
  it("toleriert beim Livemap-Feed einen vollstaendigen 1:1-Takt samt Laufzeitjitter", async () => {
    let now = 1_000;
    const livemap = new LivemapRegistry({ now: () => now });
    livemap.forWorld("public").publish({ at: 0, changed: [], removed: [] });
    const health = createLivemapHealthCheck(
      livemap,
      LIVEMAP_FRESHNESS_MAXIMUM_AGE_MS,
      () => now,
    );

    now += REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS + 1;
    await expect(health.check()).resolves.toMatchObject({ status: "ok", code: "livemap_fresh" });

    now += REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS;
    await expect(health.check()).resolves.toMatchObject({ status: "degraded", code: "livemap_stale" });
  });

  it("wertet auch einen leeren erfolgreichen Lauf als aktuellen Takt", async () => {
    let now = 1_000;
    const monitor = new RegionalSimulationSchedulerMonitor(now, () => now);
    const check = createRegionalSimulationSchedulerHealthCheck(monitor, 60_000, () => now);

    await expect(check.check()).resolves.toMatchObject({ status: "down", code: "scheduler_starting" });
    await expect(runMonitoredRegionalSimulationCycle(monitor, new Date(now), async () => 0, () => now)).resolves.toBe(0);
    await expect(check.check()).resolves.toMatchObject({ status: "ok", code: "scheduler_current" });
  });

  it("bleibt bei einer erwarteten, aber fehlenden oder falsch gebundenen Echtzeitregion down", async () => {
    let now = 1_000;
    const monitor = new RegionalSimulationSchedulerMonitor(now, () => now);
    await runMonitoredRegionalSimulationCycle(monitor, new Date(now), async () => 0, () => now);
    const expected = [{
      worldId: "public",
      regionId: "germany",
      initializationHash: "a".repeat(64),
    }];
    let ready: typeof expected = [];
    const check = createRegionalSimulationSchedulerHealthCheck(
      monitor,
      60_000,
      () => now,
      () => expected,
      () => ready,
    );

    await expect(check.check()).resolves.toMatchObject({
      status: "down",
      code: "scheduler_regions_missing",
      detail: "1/1 erwartete Echtzeitregionen sind nicht bereit",
    });
    ready = [{ ...expected[0]!, initializationHash: "b".repeat(64) }];
    await expect(check.check()).resolves.toMatchObject({
      status: "down",
      code: "scheduler_regions_missing",
    });
    ready = expected;
    await expect(check.check()).resolves.toMatchObject({
      status: "ok",
      code: "scheduler_current",
    });
  });

  it("eskaliert zwei aufeinanderfolgende Fehler und erholt sich vollstaendig", async () => {
    let now = 5_000;
    const monitor = new RegionalSimulationSchedulerMonitor(now, () => now);
    const check = createRegionalSimulationSchedulerHealthCheck(monitor, 60_000, () => now);
    const failed = async () => { throw new Error("tick failed"); };

    await expect(runMonitoredRegionalSimulationCycle(monitor, new Date(now), failed, () => now)).rejects.toThrow("tick failed");
    await expect(check.check()).resolves.toMatchObject({ status: "degraded", code: "scheduler_last_cycle_failed" });
    now += 60_000;
    await expect(runMonitoredRegionalSimulationCycle(monitor, new Date(now), failed, () => now)).rejects.toThrow("tick failed");
    await expect(check.check()).resolves.toMatchObject({ status: "down", code: "scheduler_stalled" });

    now += 60_000;
    await runMonitoredRegionalSimulationCycle(monitor, new Date(now), async () => undefined, () => now);
    await expect(check.check()).resolves.toMatchObject({ status: "ok", code: "scheduler_current" });
    expect(monitor.snapshot().consecutiveFailures).toBe(0);
  });

  it("meldet einen haengenden oder laenger ausgebliebenen Takt als down", async () => {
    let now = 10_000;
    const monitor = new RegionalSimulationSchedulerMonitor(now, () => now);
    const check = createRegionalSimulationSchedulerHealthCheck(monitor, 60_000, () => now);

    monitor.started(now);
    now += 120_001;
    await expect(check.check()).resolves.toMatchObject({ status: "down", code: "scheduler_stalled" });

    const idle = new RegionalSimulationSchedulerMonitor(0, () => now);
    await expect(createRegionalSimulationSchedulerHealthCheck(idle, 60_000, () => now).check())
      .resolves.toMatchObject({ status: "down", code: "scheduler_stalled" });
  });

  it("laesst einen langen Cold-Catch-up nur mit laufendem Fortschritt weiterlaufen", async () => {
    let now = 1_000;
    const monitor = new RegionalSimulationSchedulerMonitor(now, () => now);
    const check = createRegionalSimulationSchedulerHealthCheck(monitor, 60_000, () => now);

    monitor.started(now);
    now += 119_000;
    monitor.progress(now);
    now += 119_000;
    await expect(check.check()).resolves.toMatchObject({
      status: "down",
      code: "scheduler_catching_up",
    });

    now += 120_001;
    await expect(check.check()).resolves.toMatchObject({
      status: "down",
      code: "scheduler_stalled",
    });
  });

  it("exportiert nur begrenzte Ergebnislabels und das Alter des letzten Erfolgs", async () => {
    let now = 1_000;
    const monitor = new RegionalSimulationSchedulerMonitor(now, () => now);
    await runMonitoredRegionalSimulationCycle(monitor, new Date(now), async () => {
      now = 4_000;
    }, () => now);
    now = 6_000;
    const metrics = monitor.renderPrometheus().join("\n");

    expect(metrics).toContain('cycles_total{outcome="success"} 1');
    expect(metrics).toContain('cycles_total{outcome="failure"} 0');
    expect(metrics).toContain('cycles_total{outcome="skipped"} 0');
    expect(metrics).toContain("last_success_age_seconds 2");
    expect(metrics).toContain("last_duration_seconds 3");
    expect(metrics).toContain("maximum_duration_seconds 3");
    expect(metrics).toContain("scheduler_running 0");
    expect(metrics).toContain("scheduler_progress_age_seconds 0");
    expect(metrics).not.toContain("world_id");
    expect(metrics).not.toContain("region_id");
  });

  it("propagiert den Fehler und markiert einen abgebrochenen Lauf nie erfolgreich", async () => {
    const monitor = new RegionalSimulationSchedulerMonitor(0);
    const run = vi.fn(async () => { throw new TypeError("kaputt"); });

    await expect(runMonitoredRegionalSimulationCycle(monitor, new Date(1), run)).rejects.toThrow("kaputt");
    expect(monitor.snapshot()).toMatchObject({ successfulCycles: 0, failedCycles: 1, running: false });
  });

  it("liefert nach zwei Fehlern denselben Down-Vertrag, den der Docker-Check als unhealthy wertet", async () => {
    let now = 1_000;
    const monitor = new RegionalSimulationSchedulerMonitor(now, () => now);
    const check = createRegionalSimulationSchedulerHealthCheck(monitor, 60_000, () => now);
    monitor.failed(now);
    now += 60_000;
    monitor.failed(now);

    const health = await check.check();
    const report = { status: health.status === "down" ? "down" : health.status, checks: [health] };
    const responseOk = report.status !== "down";
    const dockerHealthy = responseOk && report.status !== "down";
    expect(health).toMatchObject({ status: "down", code: "scheduler_stalled" });
    expect(responseOk).toBe(false);
    expect(dockerHealthy).toBe(false);
  });
});
