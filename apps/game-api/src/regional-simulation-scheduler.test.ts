import { describe, expect, it, vi } from "vitest";

import { advanceRegionalSimulations, regionalSimulationSecond } from "./regional-simulation-scheduler.js";

describe("regionaler 1:1-Scheduler", () => {
  it("berechnet ausschliesslich explizite sichere Weltsekunden", () => {
    const epoch = new Date("2026-08-11T00:00:00.000Z");
    expect(regionalSimulationSecond(epoch, new Date("2026-08-11T00:00:01.999Z"))).toBe(1);
    expect(regionalSimulationSecond(epoch, new Date("2026-08-10T23:59:59.999Z"))).toBeUndefined();
    expect(() => regionalSimulationSecond(new Date(Number.NaN), epoch)).toThrow(RangeError);
  });

  it("advanciert jede bereite Region genau einmal mit stabiler Kommando-ID", async () => {
    const apply = vi.fn(async () => ({}) as never);
    const worker = {
      readyRegions: () => [
        { worldId: "world-a", regionId: "leipzig", nowS: 2 },
        { worldId: "world-a", regionId: "halle", nowS: 3 },
        { worldId: "world-b", regionId: "erfurt", nowS: 10 },
      ],
      apply,
    };
    const at = new Date("2026-08-11T00:00:05.500Z");
    await expect(
      advanceRegionalSimulations(
        worker,
        new Map([
          ["world-a", new Date("2026-08-11T00:00:00.000Z")],
          ["world-b", new Date("2026-08-11T00:00:00.000Z")],
        ]),
        at,
      ),
    ).resolves.toBe(2);
    expect(apply).toHaveBeenNthCalledWith(
      1,
      {
        worldId: "world-a",
        regionId: "leipzig",
        commandId: "advance-to:5",
        command: { type: "advance-to", atS: 5 },
      },
      at,
    );
    expect(apply).toHaveBeenNthCalledWith(
      2,
      {
        worldId: "world-a",
        regionId: "halle",
        commandId: "advance-to:5",
        command: { type: "advance-to", atS: 5 },
      },
      at,
    );
  });
});
