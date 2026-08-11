import { beforeEach, describe, expect, it, vi } from "vitest";

const { consumePendingPlanningCommands } = vi.hoisted(() => ({
  consumePendingPlanningCommands: vi.fn(async () => [{ commandId: "command" }]),
}));

vi.mock("@zugfolge/planning-worker", () => ({ consumePendingPlanningCommands }));

import { consumePlanningWorlds, createPlanningScheduler } from "./planning-scheduler.js";

beforeEach(() => {
  consumePendingPlanningCommands.mockReset();
  consumePendingPlanningCommands.mockResolvedValue([{ commandId: "command" }]);
});

describe("Planning-Consumer-Scheduler", () => {
  it("arbeitet Welten einmalig in stabiler UTF-8-Byteordnung mit expliziter Zeit ab", async () => {
    const committedAt = new Date("2026-08-11T10:00:00.000Z");
    const db = {} as never;
    const runtime = {} as never;
    const catalog = {} as never;

    await expect(
      consumePlanningWorlds(db, runtime, catalog, ["ä", "z", "z"], committedAt, 7),
    ).resolves.toBe(2);

    expect(consumePendingPlanningCommands).toHaveBeenCalledTimes(2);
    expect(consumePendingPlanningCommands.mock.calls.map((call) => call[3])).toEqual(["z", "ä"]);
    for (const call of consumePendingPlanningCommands.mock.calls) {
      expect(call[0]).toBe(db);
      expect(call[1]).toBe(runtime);
      expect(call[2]).toBe(catalog);
      expect(call[4]).toMatchObject({ limit: 7 });
      expect(call[4].committedAt()).toBe(committedAt);
    }
  });

  it("rejects implicit or unsafe scheduling inputs", async () => {
    await expect(
      consumePlanningWorlds({} as never, {} as never, {} as never, ["world"], new Date(Number.NaN)),
    ).rejects.toThrow(RangeError);
    await expect(
      consumePlanningWorlds({} as never, {} as never, {} as never, ["world"], new Date(0), 0),
    ).rejects.toThrow(RangeError);
  });

  it("pollt nicht ueberlappend und wartet beim Schliessen auf den aktiven Lauf", async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const first = new Promise<{ commandId: string }[]>((resolve) => {
      resolveFirst = () => resolve([{ commandId: "first" }]);
    });
    consumePendingPlanningCommands.mockReturnValueOnce(first);
    const scheduler = createPlanningScheduler(
      {} as never,
      {} as never,
      {} as never,
      ["world"],
      { intervalMs: 10, now: () => new Date(1_000) },
    );
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(30);
      expect(consumePendingPlanningCommands).toHaveBeenCalledOnce();

      const closing = scheduler.close();
      let closed = false;
      void closing.then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      resolveFirst();
      await closing;
      expect(closed).toBe(true);
      await vi.advanceTimersByTimeAsync(30);
      expect(consumePendingPlanningCommands).toHaveBeenCalledOnce();
    } finally {
      await scheduler.close();
      vi.useRealTimers();
    }
  });
});
