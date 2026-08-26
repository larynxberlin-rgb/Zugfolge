import { describe, expect, it, vi } from "vitest";

import {
  createRegionalSimulationSchedulerHealthCheck,
  RegionalSimulationSchedulerMonitor,
  runMonitoredRegionalSimulationCycle,
} from "./regional-simulation-monitor.js";
import {
  advanceRegionalSimulations,
  chunkWithoutSplittingBoundary,
  REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT,
  REGIONAL_SIMULATION_BATCH_SPAN_MS,
  REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT,
  regionalSimulationMillisecond,
  type RegionalSimulationSchedulerProgress,
} from "./regional-simulation-scheduler.js";
import type { RegionalSimulationWorkBatch } from "./regional-simulation-worker.js";

const INITIALIZATION_HASH = "a".repeat(64);

function resultingNowMs(work: RegionalSimulationWorkBatch, fallback = 0): number {
  let nowMs = fallback;
  for (const item of work.commands) {
    if (item.command.type === "advance-to") nowMs = item.command.atMs;
  }
  return nowMs;
}

function batchResult(nowMs: number): never {
  return { state: { world: { nowMs } } } as never;
}

describe("regionaler 1:1-Scheduler", () => {
  it("berechnet ausschliesslich explizite sichere Weltmillisekunden", () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    expect(regionalSimulationMillisecond(epoch, new Date("2026-08-11T00:00:01.999Z"))).toBe(1_999);
    expect(regionalSimulationMillisecond(epoch, new Date("2026-08-10T23:59:59.999Z"))).toBeUndefined();
    expect(() => regionalSimulationMillisecond(new Date(Number.NaN), epoch)).toThrow(RangeError);
  });

  it("advanciert jede bereite Region genau einmal mit stabiler Kommando-ID", async () => {
    const applyBatch = vi.fn(async (work: RegionalSimulationWorkBatch) =>
      batchResult(resultingNowMs(work)));
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

  it("meldet nach dem Batch die wirklich persistierte neue Weltzeit statt des alten Ready-Snapshots", async () => {
    const progress: RegionalSimulationSchedulerProgress[] = [];
    const worker = {
      readyRegions: () => [{
        worldId: "public",
        regionId: "germany",
        initializationHash: INITIALIZATION_HASH,
        nowMs: 1_000,
      }],
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
      applyBatch: vi.fn(async (work: RegionalSimulationWorkBatch) =>
        batchResult(resultingNowMs(work, 1_000))),
    };

    await expect(advanceRegionalSimulations(
      worker as never,
      [{ worldId: "public", regionId: "germany", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", new Date("2026-08-11T00:00:00.000Z")]]),
      new Date("2026-08-11T00:00:05.000Z"),
      undefined,
      (entry) => progress.push(entry),
    )).resolves.toBe(1);

    expect(progress.filter(({ phase }) => phase.startsWith("batch-") || phase === "region-completed"))
      .toEqual([{
        phase: "batch-started",
        worldId: "public",
        regionId: "germany",
        currentNowMs: 1_000,
        targetNowMs: 5_000,
        commandCount: 1,
      }, {
        phase: "batch-completed",
        worldId: "public",
        regionId: "germany",
        currentNowMs: 5_000,
        targetNowMs: 5_000,
        commandCount: 1,
      }, {
        phase: "region-completed",
        worldId: "public",
        regionId: "germany",
        currentNowMs: 5_000,
        targetNowMs: 5_000,
        commandCount: 1,
      }]);
  });

  it.each([
    ["unveraendert", 1_000],
    ["nur teilweise", 4_999],
  ])("verwirft eine %s erreichte Zielweltzeit fail-closed", async (_label, completedNowMs) => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const worker = {
      readyRegions: () => [{
        worldId: "public",
        regionId: "germany",
        initializationHash: INITIALIZATION_HASH,
        nowMs: 1_000,
      }],
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
      applyBatch: vi.fn(async () => batchResult(completedNowMs)),
    };

    await expect(advanceRegionalSimulations(
      worker as never,
      [{ worldId: "public", regionId: "germany", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      new Date("2026-08-11T00:00:05.000Z"),
    )).rejects.toThrow(/erreichte die Zielweltzeit 5000 nicht exakt/u);
  });

  it("weist eine uebergrosse atomare Zeitgrenze vor dem Workeraufruf zurueck", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const applyBatch = vi.fn(async () => batchResult(1_000));
    const scheduled = Array.from(
      { length: REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT + 1 },
      (_, index) => ({
        atMs: 1_000,
        commandId: `boundary:${index}`,
        command: {
          type: "clear-disruption" as const,
          disruptionId: `boundary:${index}`,
        },
      }),
    );

    await expect(advanceRegionalSimulations(
      {
        readyRegions: () => [{
          worldId: "public",
          regionId: "germany",
          initializationHash: INITIALIZATION_HASH,
          nowMs: 1_000,
        }],
        recover: vi.fn(),
        applyBatch,
      } as never,
      [{ worldId: "public", regionId: "germany", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      new Date("2026-08-11T00:00:01.000Z"),
      {
        at: () => scheduled,
        dueBoundaries: () => [],
      },
    )).rejects.toThrow(/mehr als 256 atomare Kommandos/u);
    expect(applyBatch).not.toHaveBeenCalled();
  });

  it("zaehlt das schedulerseitige Zeitkommando in die atomare 256er-Grenze ein", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const applyBatch = vi.fn(async () => batchResult(1_000));
    const scheduled = Array.from(
      { length: REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT },
      (_, index) => ({
        atMs: 1_000,
        commandId: `future-boundary:${index}`,
        command: {
          type: "clear-disruption" as const,
          disruptionId: `future-boundary:${index}`,
        },
      }),
    );

    await expect(advanceRegionalSimulations(
      {
        readyRegions: () => [{
          worldId: "public",
          regionId: "germany",
          initializationHash: INITIALIZATION_HASH,
          nowMs: 0,
        }],
        recover: vi.fn(),
        applyBatch,
      } as never,
      [{ worldId: "public", regionId: "germany", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      new Date(epoch.getTime() + 1_000),
      {
        at: () => [],
        dueBoundaries: () => [{ atMs: 1_000, commands: scheduled }],
      },
    )).rejects.toThrow(/mehr als 256 atomare Kommandos/u);
    expect(applyBatch).not.toHaveBeenCalled();
  });

  it("committet 255 gleichzeitige Fachkommandos mit ihrem Zeitkommando als einen Batch", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const applyBatch = vi.fn(async () => batchResult(1_000));
    const scheduled = Array.from(
      { length: REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT - 1 },
      (_, index) => ({
        atMs: 1_000,
        commandId: `future-boundary:${index}`,
        command: {
          type: "clear-disruption" as const,
          disruptionId: `future-boundary:${index}`,
        },
      }),
    );

    await expect(advanceRegionalSimulations(
      {
        readyRegions: () => [{
          worldId: "public",
          regionId: "germany",
          initializationHash: INITIALIZATION_HASH,
          nowMs: 0,
        }],
        recover: vi.fn(),
        applyBatch,
      } as never,
      [{ worldId: "public", regionId: "germany", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      new Date(epoch.getTime() + 1_000),
      {
        at: () => [],
        dueBoundaries: () => [{ atMs: 1_000, commands: scheduled }],
      },
    )).resolves.toBe(1);
    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(applyBatch.mock.calls[0]![0].commands).toHaveLength(
      REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT,
    );
    expect(applyBatch.mock.calls[0]![0].commands[0]).toEqual({
      commandId: "advance-to-ms:1000",
      command: { type: "advance-to", atMs: 1_000 },
    });
  });

  it("verweigert katalogseitige Zeitkommandos vor dem autoritativen Commit", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const applyBatch = vi.fn(async () => batchResult(1_000));

    await expect(advanceRegionalSimulations(
      {
        readyRegions: () => [{
          worldId: "public",
          regionId: "germany",
          initializationHash: INITIALIZATION_HASH,
          nowMs: 0,
        }],
        recover: vi.fn(),
        applyBatch,
      } as never,
      [{ worldId: "public", regionId: "germany", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      epoch,
      {
        at: () => [{
          atMs: 0,
          commandId: "catalog-advance",
          command: { type: "advance-to", atMs: 1_000 },
        }],
        dueBoundaries: () => [],
      },
    )).rejects.toThrow(/fremde aktuelle Zeitgrenze/u);
    expect(applyBatch).not.toHaveBeenCalled();
  });

  it("verwirft beim Start eine bereits bereite Region mit fremder Initialisierungsbindung", async () => {
    const recovered = {
      worldId: "public",
      regionId: "region",
      initializationHash: INITIALIZATION_HASH,
      nowMs: 5_000,
    };
    const recover = vi.fn(async () => recovered);
    const applyBatch = vi.fn(async (work: RegionalSimulationWorkBatch) =>
      batchResult(resultingNowMs(work, recovered.nowMs)));
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

  it("schneidet einen Catch-up-Chunk niemals innerhalb derselben Weltmillisekunde", () => {
    const commands = [
      {
        atMs: 1_000,
        command: { commandId: "advance:1000", command: { type: "advance-to" as const, atMs: 1_000 } },
      },
      {
        atMs: 2_000,
        command: { commandId: "advance:2000", command: { type: "advance-to" as const, atMs: 2_000 } },
      },
      {
        atMs: 2_000,
        command: { commandId: "clear:d-1", command: { type: "clear-disruption" as const, disruptionId: "d-1" } },
      },
    ];

    const chunks = chunkWithoutSplittingBoundary(commands, 2);
    expect(chunks.map((chunk) => chunk.map(({ command }) => command.commandId))).toEqual([
      ["advance:1000"],
      ["advance:2000", "clear:d-1"],
    ]);
  });

  it("konsumiert grosse Catch-ups lazily, begrenzt und in exakt deterministischer Reihenfolge", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const targetMs = 1_101;
    let yieldedBoundaries = 0;
    let persistedNowMs = 0;
    const yieldedAtApply: number[] = [];
    const appliedCommandIds: string[] = [];
    const progress: RegionalSimulationSchedulerProgress[] = [];
    const applyBatch = vi.fn(async (work: RegionalSimulationWorkBatch) => {
      yieldedAtApply.push(yieldedBoundaries);
      expect(work.commands.length).toBeLessThanOrEqual(REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT);
      appliedCommandIds.push(...work.commands.map(({ commandId }) => commandId));
      persistedNowMs = resultingNowMs(work, persistedNowMs);
      return batchResult(persistedNowMs);
    });

    await expect(advanceRegionalSimulations(
      {
        readyRegions: () => [{
          worldId: "public",
          regionId: "germany",
          initializationHash: INITIALIZATION_HASH,
          nowMs: 0,
        }],
        recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
        applyBatch,
      },
      [{ worldId: "public", regionId: "germany", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      new Date(epoch.getTime() + targetMs),
      {
        at: () => [],
        *dueBoundaries() {
          for (let atMs = 1; atMs <= targetMs; atMs += 1) {
            yieldedBoundaries += 1;
            yield {
              atMs,
              commands: [{
                atMs,
                commandId: `clear:${atMs}`,
                command: { type: "clear-disruption" as const, disruptionId: `d-${atMs}` },
              }],
            };
          }
        },
      },
      (entry) => progress.push(entry),
    )).resolves.toBe(1);

    expect(applyBatch.mock.calls.map(([work]) => work.commands.length)).toEqual([
      ...Array.from({ length: 8 }, () => REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT),
      154,
    ]);
    expect(yieldedAtApply).toEqual([129, 257, 385, 513, 641, 769, 897, 1_025, targetMs]);
    expect(appliedCommandIds).toEqual(Array.from(
      { length: targetMs },
      (_, index) => [
        `advance-to-ms:${index + 1}`,
        `clear:${index + 1}`,
      ],
    ).flat());
    expect(progress).toContainEqual(expect.objectContaining({
      phase: "region-completed",
      currentNowMs: targetMs,
      targetNowMs: targetMs,
      commandCount: targetMs * 2,
    }));
  });

  it("teilt lange Luecken an absoluten Minutenmarken und verschmilzt Kataloggrenzen", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const targetMs = 1_000_123;
    let persistedNowMs = 125_000;
    const batchStarts: number[] = [];
    const applied: RegionalSimulationWorkBatch[] = [];
    const progress: RegionalSimulationSchedulerProgress[] = [];
    const boundaries = [300_000, 750_000, targetMs].map((atMs) => ({
      atMs,
      commands: [{
        atMs,
        commandId: `clear:${atMs}`,
        command: { type: "clear-disruption" as const, disruptionId: `d-${atMs}` },
      }],
    }));
    const applyBatch = vi.fn(async (work: RegionalSimulationWorkBatch) => {
      batchStarts.push(persistedNowMs);
      applied.push(work);
      expect(work.commands.length).toBeLessThanOrEqual(REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT);
      const completedNowMs = resultingNowMs(work, persistedNowMs);
      expect(completedNowMs - persistedNowMs).toBeLessThanOrEqual(REGIONAL_SIMULATION_BATCH_SPAN_MS);
      persistedNowMs = completedNowMs;
      return batchResult(persistedNowMs);
    });

    await expect(advanceRegionalSimulations(
      {
        readyRegions: () => [{
          worldId: "public",
          regionId: "germany",
          initializationHash: INITIALIZATION_HASH,
          nowMs: persistedNowMs,
        }],
        recover: vi.fn(),
        applyBatch,
      } as never,
      [{ worldId: "public", regionId: "germany", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      new Date(epoch.getTime() + targetMs),
      {
        at: () => [],
        *dueBoundaries(_worldId, _regionId, afterMs, throughMs) {
          yield* boundaries.filter(({ atMs }) => atMs > afterMs && atMs <= throughMs);
        },
      },
      (entry) => progress.push(entry),
    )).resolves.toBe(1);

    expect(batchStarts).toEqual([
      125_000,
      180_000,
      240_000,
      300_000,
      360_000,
      420_000,
      480_000,
      540_000,
      600_000,
      660_000,
      720_000,
      780_000,
      840_000,
      900_000,
      960_000,
    ]);
    expect(applied.map(({ commands }) => commands.map(({ commandId }) => commandId))).toEqual([
      ["advance-to-ms:180000"],
      ["advance-to-ms:240000"],
      ["advance-to-ms:300000", "clear:300000"],
      ["advance-to-ms:360000"],
      ["advance-to-ms:420000"],
      ["advance-to-ms:480000"],
      ["advance-to-ms:540000"],
      ["advance-to-ms:600000"],
      ["advance-to-ms:660000"],
      ["advance-to-ms:720000"],
      ["advance-to-ms:750000", "clear:750000", "advance-to-ms:780000"],
      ["advance-to-ms:840000"],
      ["advance-to-ms:900000"],
      ["advance-to-ms:960000"],
      [`advance-to-ms:${targetMs}`, `clear:${targetMs}`],
    ]);
    expect(persistedNowMs).toBe(targetMs);
    expect(progress).toContainEqual(expect.objectContaining({
      phase: "region-completed",
      currentNowMs: targetMs,
      targetNowMs: targetMs,
      commandCount: 19,
    }));
  });

  it("setzt nach einem committeten Checkpoint mit denselben IDs nur am persistierten Suffix fort", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const targetMs = 650_000;
    let persistedNowMs = 240_000;
    let failAfterFirstCommit = true;
    const committed = new Set<string>();
    const effects: string[] = [];
    const calls: string[][] = [];
    const scheduled = [300_000, 600_000].map((atMs) => ({
      atMs,
      commandId: `clear:${atMs}`,
      command: { type: "clear-disruption" as const, disruptionId: `d-${atMs}` },
    }));
    const applyBatch = vi.fn(async (work: RegionalSimulationWorkBatch) => {
      calls.push(work.commands.map(({ commandId }) => commandId));
      for (const item of work.commands) {
        if (committed.has(item.commandId)) continue;
        committed.add(item.commandId);
        if (item.command.type === "advance-to") persistedNowMs = item.command.atMs;
        else effects.push(item.commandId);
      }
      if (failAfterFirstCommit) {
        failAfterFirstCommit = false;
        throw new Error("Crash nach Checkpoint-Commit");
      }
      return batchResult(persistedNowMs);
    });
    const worker = {
      readyRegions: () => [{
        worldId: "public",
        regionId: "germany",
        initializationHash: INITIALIZATION_HASH,
        nowMs: persistedNowMs,
      }],
      recover: vi.fn(),
      applyBatch,
    };
    const catalog = {
      at: (_worldId: string, _regionId: string, atMs: number) =>
        scheduled.filter((command) => command.atMs === atMs),
      *dueBoundaries(
        _worldId: string,
        _regionId: string,
        afterMs: number,
        throughMs: number,
      ) {
        for (const command of scheduled) {
          if (command.atMs > afterMs && command.atMs <= throughMs) {
            yield { atMs: command.atMs, commands: [command] };
          }
        }
      },
    };
    const advance = () => advanceRegionalSimulations(
      worker as never,
      [{ worldId: "public", regionId: "germany", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      new Date(epoch.getTime() + targetMs),
      catalog,
    );

    await expect(advance()).rejects.toThrow("Crash nach Checkpoint-Commit");
    expect(persistedNowMs).toBe(300_000);
    expect(effects).toEqual(["clear:300000"]);

    await expect(advance()).resolves.toBe(1);
    expect(persistedNowMs).toBe(targetMs);
    expect(effects).toEqual(["clear:300000", "clear:600000"]);
    expect(calls).toEqual([
      ["advance-to-ms:300000", "clear:300000"],
      ["clear:300000"],
      ["advance-to-ms:360000"],
      ["advance-to-ms:420000"],
      ["advance-to-ms:480000"],
      ["advance-to-ms:540000"],
      ["advance-to-ms:600000", "clear:600000"],
      [`advance-to-ms:${targetMs}`],
    ]);

    await expect(advance()).resolves.toBe(0);
    expect(calls).toHaveLength(8);
  });

  it("verweigert einen in mehrere Streamteile gespaltenen atomaren Zeitpunkt vor dem Commit", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const applyBatch = vi.fn(async () => batchResult(128));

    await expect(advanceRegionalSimulations(
      {
        readyRegions: () => [{
          worldId: "public",
          regionId: "germany",
          initializationHash: INITIALIZATION_HASH,
          nowMs: 0,
        }],
        recover: vi.fn(),
        applyBatch,
      } as never,
      [{ worldId: "public", regionId: "germany", initializationHash: INITIALIZATION_HASH }],
      new Map([["public", epoch]]),
      new Date(epoch.getTime() + 128),
      {
        at: () => [],
        *dueBoundaries() {
          for (let atMs = 1; atMs <= 127; atMs += 1) {
            yield {
              atMs,
              commands: [{
                atMs,
                commandId: `prefix:${atMs}`,
                command: { type: "clear-disruption" as const, disruptionId: `prefix:${atMs}` },
              }],
            };
          }
          for (const commandId of ["first", "split"]) {
            yield {
              atMs: 128,
              commands: [{
                atMs: 128,
                commandId,
                command: { type: "clear-disruption" as const, disruptionId: commandId },
              }],
            };
          }
        },
      },
    )).rejects.toThrow(/unvollstaendige oder ungeordnete Zeitgrenze/u);
    expect(applyBatch).not.toHaveBeenCalled();
  });

  it("ignoriert nach einem Neustart restaurierte Tutorialregionen ohne Echtzeitregistrierung", async () => {
    const applyBatch = vi.fn(async (work: RegionalSimulationWorkBatch) =>
      batchResult(resultingNowMs(work)));
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
    const applyBatch = vi.fn(async (work: RegionalSimulationWorkBatch) =>
      batchResult(resultingNowMs(work)));
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
    const applyBatch = vi.fn(async (work: RegionalSimulationWorkBatch) => {
      if (work.worldId === "broken") throw new Error("kaputter Regionstakt");
      return batchResult(resultingNowMs(work));
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
      return batchResult(nowMs);
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
      *dueBoundaries(
        _worldId: string,
        _regionId: string,
        afterMs: number,
        throughMs: number,
      ) {
        const due = commands.filter((command) =>
          command.atMs > afterMs && command.atMs <= throughMs);
        if (due.length > 0) yield { atMs: due[0]!.atMs, commands: due };
      },
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
      applyBatch: vi.fn(async (work: RegionalSimulationWorkBatch) =>
        batchResult(resultingNowMs(work, recoveredRegion.nowMs))),
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

  it("schreitet zehn aufeinanderfolgende Intervalle in Zeit, Revision und Publishersequenz fort", async () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    const registration = {
      worldId: "public",
      regionId: "germany",
      initializationHash: INITIALIZATION_HASH,
    };
    let nowMs = 0;
    let revision = 0;
    let publisherSequence = 0;
    let wallNow = epoch.getTime();
    const heads: Array<Readonly<{
      nowMs: number;
      revision: number;
      publisherSequence: number;
    }>> = [];
    const worker = {
      readyRegions: () => [{ ...registration, nowMs }],
      recover: vi.fn(async () => { throw new Error("unerwartete Recovery"); }),
      applyBatch: vi.fn(async (work: RegionalSimulationWorkBatch) => {
        expect(work.commands).toHaveLength(1);
        const command = work.commands[0]!.command;
        expect(command.type).toBe("advance-to");
        if (command.type !== "advance-to") throw new Error("unerwartetes Fachkommando");
        nowMs = command.atMs;
        revision += 1;
        publisherSequence += 1;
        heads.push({ nowMs, revision, publisherSequence });
        return batchResult(nowMs);
      }),
    };
    const monitor = new RegionalSimulationSchedulerMonitor(wallNow, () => wallNow);
    const health = createRegionalSimulationSchedulerHealthCheck(monitor, 60_000, () => wallNow);

    for (let interval = 1; interval <= 10; interval += 1) {
      wallNow = epoch.getTime() + interval * 60_000;
      const at = new Date(wallNow);
      await expect(runMonitoredRegionalSimulationCycle(
        monitor,
        at,
        () => advanceRegionalSimulations(
          worker as never,
          [registration],
          new Map([[registration.worldId, epoch]]),
          at,
        ),
        () => wallNow,
      )).resolves.toBe(1);
      await expect(health.check()).resolves.toMatchObject({ status: "ok", code: "scheduler_current" });
    }

    expect(heads).toEqual(Array.from({ length: 10 }, (_, index) => ({
      nowMs: (index + 1) * 60_000,
      revision: index + 1,
      publisherSequence: index + 1,
    })));
    expect(monitor.snapshot()).toMatchObject({
      successfulCycles: 10,
      failedCycles: 0,
      consecutiveFailures: 0,
    });
  });
});
