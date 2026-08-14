import { describe, expect, it, vi } from "vitest";

import {
  createRegionalSimulationSchedulerHealthCheck,
  RegionalSimulationSchedulerMonitor,
  runMonitoredRegionalSimulationCycle,
} from "./regional-simulation-monitor.js";
import { advanceRegionalSimulations, regionalSimulationSecond } from "./regional-simulation-scheduler.js";

describe("regionaler 1:1-Scheduler", () => {
  it("berechnet ausschliesslich explizite sichere Weltsekunden", () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    expect(regionalSimulationSecond(epoch, new Date("2026-08-11T00:00:01.999Z"))).toBe(1);
    expect(regionalSimulationSecond(epoch, new Date("2026-08-10T23:59:59.999Z"))).toBeUndefined();
    expect(() => regionalSimulationSecond(new Date(Number.NaN), epoch)).toThrow(RangeError);
  });

  it("advanciert jede bereite Region genau einmal mit stabiler Kommando-ID", async () => {
    const applyBatch = vi.fn(async () => ({}) as never);
    const worker = {
      readyRegions: () => [
        { worldId: "world-a", regionId: "leipzig", nowS: 2 },
        { worldId: "world-a", regionId: "halle", nowS: 3 },
        { worldId: "world-b", regionId: "erfurt", nowS: 10 },
      ],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const at = new Date("2026-08-11T00:00:05.500Z");
    await expect(
      advanceRegionalSimulations(
        worker,
        [
          { worldId: "world-b", regionId: "erfurt" },
          { worldId: "world-a", regionId: "leipzig" },
          { worldId: "world-a", regionId: "halle" },
          { worldId: "world-a", regionId: "halle" },
        ],
        new Map([
          ["world-a", new Date("2026-08-11T00:00:00.000Z")],
          ["world-b", new Date("2026-08-11T00:00:00.000Z")],
        ]),
        at,
      ),
    ).resolves.toBe(2);
    expect(applyBatch).toHaveBeenNthCalledWith(
      1,
      {
        worldId: "world-a",
        regionId: "halle",
        commands: [{ commandId: "advance-to:5", command: { type: "advance-to", atS: 5 } }],
      },
      at,
    );
    expect(applyBatch).toHaveBeenNthCalledWith(
      2,
      {
        worldId: "world-a",
        regionId: "leipzig",
        commands: [{ commandId: "advance-to:5", command: { type: "advance-to", atS: 5 } }],
      },
      at,
    );
  });

  it("schneidet einen Catch-up-Chunk niemals innerhalb derselben Weltsekunde", async () => {
    const applyBatch = vi.fn(async () => ({}) as never);
    const worker = {
      readyRegions: () => [{ worldId: "public", regionId: "region", nowS: 0 }],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const transitions = Array.from({ length: 2_001 }, (_, index) => ({
      transitionId: `boundary:${index.toString().padStart(4, "0")}`,
      worldId: "public",
      regionId: "region",
      atS: 1,
      command: { type: "dematerialize-before" as const, beforeS: 0 },
    }));
    const catalog = {
      at: () => [],
      due: () => transitions,
    };

    await expect(advanceRegionalSimulations(
      worker,
      [{ worldId: "public", regionId: "region" }],
      new Map([["public", new Date("2026-08-11T00:00:00.000Z")]]),
      new Date("2026-08-11T00:00:01.000Z"),
      catalog,
    )).resolves.toBe(1);
    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(applyBatch.mock.calls[0]![0].commands).toHaveLength(2_002);
    expect(applyBatch.mock.calls[0]![0].commands[0]).toEqual({
      commandId: "advance-to:1",
      command: { type: "advance-to", atS: 1 },
    });
    expect(applyBatch.mock.calls[0]![0].commands.at(-1)?.commandId).toBe("boundary:2000");
  });

  it("ignoriert nach einem Neustart restaurierte Tutorialregionen ohne Echtzeitregistrierung", async () => {
    const applyBatch = vi.fn(async () => ({}) as never);
    const worker = {
      readyRegions: () => [
        { worldId: "active-tutorial", regionId: "tutorial-region", nowS: 90_220 },
        { worldId: "archived-tutorial", regionId: "tutorial-region", nowS: 90_220 },
        { worldId: "public", regionId: "public-region", nowS: 1 },
      ],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const at = new Date("2026-08-11T00:00:05.000Z");

    await expect(advanceRegionalSimulations(
      worker,
      [{ worldId: "public", regionId: "public-region" }],
      new Map([["public", new Date("2026-08-11T00:00:00.000Z")]]),
      at,
    )).resolves.toBe(1);
    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(applyBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        worldId: "public",
        regionId: "public-region",
        commands: [{ commandId: "advance-to:5", command: { type: "advance-to", atS: 5 } }],
      }),
      at,
    );
  });

  it("meldet eine fehlende Epoche hart, nachdem andere registrierte Regionen fortgeschritten sind", async () => {
    const applyBatch = vi.fn(async () => ({}) as never);
    const worker = {
      readyRegions: () => [
        { worldId: "missing", regionId: "a", nowS: 0 },
        { worldId: "working", regionId: "b", nowS: 0 },
      ],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const at = new Date("2026-08-11T00:00:05.000Z");

    await expect(advanceRegionalSimulations(
      worker,
      [
        { worldId: "missing", regionId: "a" },
        { worldId: "working", regionId: "b" },
      ],
      new Map([["working", new Date("2026-08-11T00:00:00.000Z")]]),
      at,
    )).rejects.toThrow("Welt-Epoche fuer regionale Simulation 'missing' fehlt.");
    expect(applyBatch).toHaveBeenCalledWith(
      expect.objectContaining({ worldId: "working", regionId: "b" }),
      at,
    );
  });

  it("isoliert einen Workerfehler und taktet nachfolgende registrierte Regionen weiter", async () => {
    const applyBatch = vi.fn(async (work: { readonly worldId: string }) => {
      if (work.worldId === "broken") throw new Error("kaputter Regionstakt");
      return {} as never;
    });
    const worker = {
      readyRegions: () => [
        { worldId: "broken", regionId: "a", nowS: 0 },
        { worldId: "working", regionId: "b", nowS: 0 },
      ],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const epoch = new Date("2026-08-11T00:00:00.000Z");

    await expect(advanceRegionalSimulations(
      worker as never,
      [
        { worldId: "broken", regionId: "a" },
        { worldId: "working", regionId: "b" },
      ],
      new Map([["broken", epoch], ["working", epoch]]),
      new Date("2026-08-11T00:00:05.000Z"),
    )).rejects.toThrow("kaputter Regionstakt");
    expect(applyBatch.mock.calls.map(([work]) => work.worldId)).toEqual(["broken", "working"]);
  });

  it("committet eine Grenze atomar und wiederholt nach verlorenem Fanout nur ihren Suffix", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const at = new Date("2026-08-11T00:00:05.000Z");
    let nowS = 0;
    let failAfterBatchCommit = true;
    const committed = new Set<string>();
    const effects: string[] = [];
    const applyBatch = vi.fn(async (work: {
      readonly commands: readonly {
        readonly commandId: string;
        readonly command: { readonly type: string; readonly atS?: number };
      }[];
    }) => {
      for (const item of work.commands) {
        if (committed.has(item.commandId)) continue;
        committed.add(item.commandId);
        if (item.command.type === "advance-to") {
          nowS = item.command.atS ?? nowS;
        } else {
          effects.push(item.commandId);
        }
      }
      if (failAfterBatchCommit) {
        failAfterBatchCommit = false;
        throw new Error("Crash nach autoritativem Grenzbatch-Commit");
      }
      return {} as never;
    });
    const worker = {
      readyRegions: () => [{ worldId: "public", regionId: "region", nowS }],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const commands = [
      {
        transitionId: "materialize:a:day-1",
        worldId: "public",
        regionId: "region",
        atS: 5,
        command: { type: "dematerialize-before" as const, beforeS: 0 },
      },
      {
        transitionId: "materialize:b:day-1",
        worldId: "public",
        regionId: "region",
        atS: 5,
        command: { type: "dematerialize-before" as const, beforeS: 0 },
      },
    ];
    const catalog = {
      at: (_worldId: string, _regionId: string, boundaryS: number) =>
        commands.filter((command) => command.atS === boundaryS),
      due: (_worldId: string, _regionId: string, afterS: number, throughS: number) =>
        commands.filter((command) => command.atS > afterS && command.atS <= throughS),
    };

    await expect(advanceRegionalSimulations(
      worker as never,
      [{ worldId: "public", regionId: "region" }],
      new Map([["public", epoch]]),
      at,
      catalog,
    )).rejects.toThrow("Crash nach autoritativem Grenzbatch-Commit");
    expect(nowS).toBe(5);
    expect(effects).toEqual(["materialize:a:day-1", "materialize:b:day-1"]);

    await expect(advanceRegionalSimulations(
      worker as never,
      [{ worldId: "public", regionId: "region" }],
      new Map([["public", epoch]]),
      at,
      catalog,
    )).resolves.toBe(0);
    expect(effects).toEqual(["materialize:a:day-1", "materialize:b:day-1"]);

    await expect(advanceRegionalSimulations(
      worker as never,
      [{ worldId: "public", regionId: "region" }],
      new Map([["public", epoch]]),
      at,
      catalog,
    )).resolves.toBe(0);
    expect(effects).toEqual(["materialize:a:day-1", "materialize:b:day-1"]);
  });

  it("bleibt nach verlorener Public-Region down, bis der persistierte Feed wirklich restauriert ist", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const registration = { worldId: "public", regionId: "mitteldeutschland" };
    const recoveredRegion = { ...registration, nowS: 5 };
    let recovered = false;
    let recoveryAvailable = false;
    let monitorNow = 1_000;
    const worker = {
      readyRegions: () => recovered ? [recoveredRegion] : [],
      applyBatch: vi.fn(async () => ({}) as never),
      recover: vi.fn(async () => {
        if (!recoveryAvailable) throw new Error("Livemap-Fanout weiter nicht verfuegbar");
        recovered = true;
        return recoveredRegion;
      }),
    };
    const monitor = new RegionalSimulationSchedulerMonitor(monitorNow, () => monitorNow);
    const health = createRegionalSimulationSchedulerHealthCheck(monitor, 60_000, () => monitorNow);
    const run = () => runMonitoredRegionalSimulationCycle(
      monitor,
      new Date("2026-08-11T00:00:05.000Z"),
      () => advanceRegionalSimulations(
        worker as never,
        [registration],
        new Map([[registration.worldId, epoch]]),
        new Date("2026-08-11T00:00:05.000Z"),
      ),
      () => monitorNow,
    );

    await expect(run()).rejects.toThrow("Livemap-Fanout weiter nicht verfuegbar");
    monitorNow += 60_000;
    await expect(run()).rejects.toThrow("Livemap-Fanout weiter nicht verfuegbar");
    await expect(health.check()).resolves.toMatchObject({ status: "down" });

    monitorNow += 60_000;
    await expect(run()).rejects.toThrow("Livemap-Fanout weiter nicht verfuegbar");
    await expect(health.check()).resolves.toMatchObject({ status: "down" });

    recoveryAvailable = true;
    monitorNow += 60_000;
    await expect(run()).resolves.toBe(0);
    expect(worker.recover).toHaveBeenCalledTimes(4);
    expect(worker.applyBatch).not.toHaveBeenCalled();
    await expect(health.check()).resolves.toMatchObject({ status: "ok", code: "scheduler_current" });
  });
});
