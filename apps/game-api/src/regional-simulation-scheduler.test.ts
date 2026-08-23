import { describe, expect, it, vi } from "vitest";

import {
  createRegionalSimulationSchedulerHealthCheck,
  RegionalSimulationSchedulerMonitor,
  runMonitoredRegionalSimulationCycle,
} from "./regional-simulation-monitor.js";
import {
  advanceRegionalSimulations,
  regionalSimulationMillisecond,
} from "./regional-simulation-scheduler.js";
import type { RegionalSimulationWorkBatch } from "./regional-simulation-worker.js";

const INITIALIZATION_HASH = "a".repeat(64);

describe("regionaler 1:1-Scheduler", () => {
  it("berechnet ausschliesslich explizite sichere Weltmillisekunden", () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    expect(regionalSimulationMillisecond(epoch, new Date("2026-08-11T00:00:01.999Z"))).toBe(1_999);
    expect(regionalSimulationMillisecond(epoch, new Date("2026-08-10T23:59:59.999Z"))).toBeUndefined();
    expect(() => regionalSimulationMillisecond(new Date(Number.NaN), epoch)).toThrow(RangeError);
  });

  it("advanciert jede bereite Region genau einmal mit stabiler Kommando-ID", async () => {
    const applyBatch = vi.fn(async () => ({}) as never);
    const worker = {
      readyRegions: () => [
        { worldId: "world-a", regionId: "leipzig", initializationHash: INITIALIZATION_HASH, nowMs: 2_000 },
        { worldId: "world-a", regionId: "halle", initializationHash: INITIALIZATION_HASH, nowMs: 3_000 },
        { worldId: "world-b", regionId: "erfurt", initializationHash: INITIALIZATION_HASH, nowMs: 10_000 },
      ],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const at = new Date("2026-08-11T00:00:05.500Z");
    await expect(
      advanceRegionalSimulations(
        worker,
        [
          { worldId: "world-b", regionId: "erfurt", initializationHash: INITIALIZATION_HASH },
          { worldId: "world-a", regionId: "leipzig", initializationHash: INITIALIZATION_HASH },
          { worldId: "world-a", regionId: "halle", initializationHash: INITIALIZATION_HASH },
          { worldId: "world-a", regionId: "halle", initializationHash: INITIALIZATION_HASH },
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
        commands: [{ commandId: "advance-to-ms:5500", command: { type: "advance-to", atMs: 5_500 } }],
      },
      at,
    );
    expect(applyBatch).toHaveBeenNthCalledWith(
      2,
      {
        worldId: "world-a",
        regionId: "leipzig",
        commands: [{ commandId: "advance-to-ms:5500", command: { type: "advance-to", atMs: 5_500 } }],
      },
      at,
    );
  });

  it("verwirft beim Start eine bereits bereite Region mit fremder Initialisierungsbindung", async () => {
    const recovered = {
      worldId: "public",
      regionId: "region",
      initializationHash: INITIALIZATION_HASH,
      nowMs: 5_000,
    };
    const recover = vi.fn(async () => recovered);
    const applyBatch = vi.fn(async () => ({}) as never);
    const worker = {
      readyRegions: () => [{
        ...recovered,
        initializationHash: "b".repeat(64),
      }],
      recover,
      applyBatch,
    };

    await expect(advanceRegionalSimulations(
      worker,
      [{ worldId: "public", regionId: "region", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", new Date("2026-08-11T00:00:00.000Z")]]),
      new Date("2026-08-11T00:00:05.000Z"),
    )).resolves.toBe(0);
    expect(recover).toHaveBeenCalledWith("public", "region", INITIALIZATION_HASH);
    expect(applyBatch).not.toHaveBeenCalled();
  });

  it("schneidet einen Catch-up-Chunk niemals innerhalb derselben Weltmillisekunde", async () => {
    const applyBatch = vi.fn(async (
      _work: RegionalSimulationWorkBatch,
      _persistedAt: Date,
    ) => ({}) as never);
    const worker = {
      readyRegions: () => [{
        worldId: "public",
        regionId: "region",
        initializationHash: INITIALIZATION_HASH,
        nowMs: 0,
      }],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const commands = Array.from({ length: 2_001 }, (_, index) => ({
      commandId: `disruption:${index.toString().padStart(4, "0")}`,
      atMs: 1_000,
      command: {
        type: "activate-disruption" as const,
        disruptionId: `disruption-${index}`,
        effect: { kind: "signal-failure" },
      },
    }));
    const catalog = {
      at: () => [],
      due: () => commands,
    };

    await expect(advanceRegionalSimulations(
      worker,
      [{ worldId: "public", regionId: "region", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", new Date("2026-08-11T00:00:00.000Z")]]),
      new Date("2026-08-11T00:00:01.000Z"),
      catalog,
    )).resolves.toBe(1);
    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(applyBatch.mock.calls[0]![0].commands).toHaveLength(2_002);
    expect(applyBatch.mock.calls[0]![0].commands[0]).toEqual({
      commandId: "advance-to-ms:1000",
      command: { type: "advance-to", atMs: 1_000 },
    });
    expect(applyBatch.mock.calls[0]![0].commands.at(-1)?.commandId).toBe("disruption:2000");
  });

  it("ignoriert nach einem Neustart restaurierte Tutorialregionen ohne Echtzeitregistrierung", async () => {
    const applyBatch = vi.fn(async () => ({}) as never);
    const worker = {
      readyRegions: () => [
        {
          worldId: "active-tutorial",
          regionId: "tutorial-region",
          initializationHash: INITIALIZATION_HASH,
          nowMs: 90_220_000,
        },
        {
          worldId: "archived-tutorial",
          regionId: "tutorial-region",
          initializationHash: INITIALIZATION_HASH,
          nowMs: 90_220_000,
        },
        {
          worldId: "public",
          regionId: "public-region",
          initializationHash: INITIALIZATION_HASH,
          nowMs: 1_000,
        },
      ],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const at = new Date("2026-08-11T00:00:05.000Z");

    await expect(advanceRegionalSimulations(
      worker,
      [{ worldId: "public", regionId: "public-region", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", new Date("2026-08-11T00:00:00.000Z")]]),
      at,
    )).resolves.toBe(1);
    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(applyBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        worldId: "public",
        regionId: "public-region",
        commands: [{ commandId: "advance-to-ms:5000", command: { type: "advance-to", atMs: 5_000 } }],
      }),
      at,
    );
  });

  it("meldet eine fehlende Epoche hart, nachdem andere registrierte Regionen fortgeschritten sind", async () => {
    const applyBatch = vi.fn(async () => ({}) as never);
    const worker = {
      readyRegions: () => [
        { worldId: "missing", regionId: "a", initializationHash: INITIALIZATION_HASH, nowMs: 0 },
        { worldId: "working", regionId: "b", initializationHash: INITIALIZATION_HASH, nowMs: 0 },
      ],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const at = new Date("2026-08-11T00:00:05.000Z");

    await expect(advanceRegionalSimulations(
      worker,
      [
        { worldId: "missing", regionId: "a", initializationHash: INITIALIZATION_HASH },
        { worldId: "working", regionId: "b", initializationHash: INITIALIZATION_HASH },
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
        { worldId: "broken", regionId: "a", initializationHash: INITIALIZATION_HASH, nowMs: 0 },
        { worldId: "working", regionId: "b", initializationHash: INITIALIZATION_HASH, nowMs: 0 },
      ],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const epoch = new Date("2026-08-11T00:00:00.000Z");

    await expect(advanceRegionalSimulations(
      worker as never,
      [
        { worldId: "broken", regionId: "a", initializationHash: INITIALIZATION_HASH },
        { worldId: "working", regionId: "b", initializationHash: INITIALIZATION_HASH },
      ],
      new Map([["broken", epoch], ["working", epoch]]),
      new Date("2026-08-11T00:00:05.000Z"),
    )).rejects.toThrow("kaputter Regionstakt");
    expect(applyBatch.mock.calls.map(([work]) => work.worldId)).toEqual(["broken", "working"]);
  });

  it("committet gleichzeitige Fachkommandos atomar und wiederholt nach verlorenem Fanout nur ihren Suffix", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const at = new Date("2026-08-11T00:00:05.000Z");
    let nowMs = 0;
    let failAfterBatchCommit = true;
    const committed = new Set<string>();
    const effects: string[] = [];
    const applyBatch = vi.fn(async (work: {
      readonly commands: readonly {
        readonly commandId: string;
        readonly command: { readonly type: string; readonly atMs?: number };
      }[];
    }) => {
      for (const item of work.commands) {
        if (committed.has(item.commandId)) continue;
        committed.add(item.commandId);
        if (item.command.type === "advance-to") {
          nowMs = item.command.atMs ?? nowMs;
        } else {
          effects.push(item.commandId);
        }
      }
      if (failAfterBatchCommit) {
        failAfterBatchCommit = false;
        throw new Error("Crash nach autoritativem Fachkommando-Batch-Commit");
      }
      return {} as never;
    });
    const worker = {
      readyRegions: () => [{
        worldId: "public",
        regionId: "region",
        initializationHash: INITIALIZATION_HASH,
        nowMs,
      }],
      applyBatch,
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
    };
    const commands = [
      {
        commandId: "activate-disruption:a",
        atMs: 5_000,
        command: {
          type: "activate-disruption" as const,
          disruptionId: "disruption-a",
          effect: { kind: "signal-failure" },
        },
      },
      {
        commandId: "activate-disruption:b",
        atMs: 5_000,
        command: {
          type: "activate-disruption" as const,
          disruptionId: "disruption-b",
          effect: { kind: "switch-failure" },
        },
      },
    ];
    const catalog = {
      at: (_worldId: string, _regionId: string, boundaryMs: number) =>
        commands.filter((command) => command.atMs === boundaryMs),
      due: (_worldId: string, _regionId: string, afterMs: number, throughMs: number) =>
        commands.filter((command) => command.atMs > afterMs && command.atMs <= throughMs),
    };

    await expect(advanceRegionalSimulations(
      worker as never,
      [{ worldId: "public", regionId: "region", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      at,
      catalog,
    )).rejects.toThrow("Crash nach autoritativem Fachkommando-Batch-Commit");
    expect(nowMs).toBe(5_000);
    expect(effects).toEqual(["activate-disruption:a", "activate-disruption:b"]);

    await expect(advanceRegionalSimulations(
      worker as never,
      [{ worldId: "public", regionId: "region", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      at,
      catalog,
    )).resolves.toBe(0);
    expect(effects).toEqual(["activate-disruption:a", "activate-disruption:b"]);

    await expect(advanceRegionalSimulations(
      worker as never,
      [{ worldId: "public", regionId: "region", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      at,
      catalog,
    )).resolves.toBe(0);
    expect(effects).toEqual(["activate-disruption:a", "activate-disruption:b"]);
  });

  it("bleibt nach verlorener Public-Region down, bis der persistierte Feed wirklich restauriert ist", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const registration = {
      worldId: "public",
      regionId: "mitteldeutschland",
      initializationHash: INITIALIZATION_HASH,
    };
    const recoveredRegion = { ...registration, nowMs: 5_000 };
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
