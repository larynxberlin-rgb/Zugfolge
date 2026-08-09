import { describe, expect, it, vi } from "vitest";

import {
  createLivemapHealthCheck,
  LivemapCapacityError,
  LivemapFeed,
  LivemapRegistry,
} from "./stream.js";

const train = {
  id: "7",
  operator: "EVU",
  trainNumber: "RE 7",
  category: "regional",
  positionMm: 1,
  speedMmPerSecond: 2,
  delaySeconds: 0,
  nextOperatingPoint: "Halle",
  status: "running",
};

describe("LivemapFeed", () => {
  it("sequenziert, materialisiert und verteilt Deltas", () => {
    const feed = new LivemapFeed("welt-a");
    const listener = vi.fn();
    feed.subscribe(listener);
    expect(feed.publish({ at: 10, changed: [train], removed: [] }).sequence).toBe(1);
    expect(feed.snapshot().trains).toEqual([train]);
    feed.publish({ at: 20, changed: [], removed: ["7"] });
    expect(feed.snapshot().trains).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("liefert begrenztes Delta-Replay und erkennt einen zu alten Client", () => {
    const feed = new LivemapFeed("welt-a", 2);
    feed.publish({ at: 10, changed: [train], removed: [] });
    feed.publish({ at: 20, changed: [], removed: [] });
    feed.publish({ at: 30, changed: [], removed: [] });
    expect(feed.deltasAfter(1)?.map((delta) => delta.sequence)).toEqual([2, 3]);
    expect(feed.deltasAfter(0)).toBeUndefined();
  });
});

describe("LivemapRegistry", () => {
  it("isoliert Welten", () => {
    const registry = new LivemapRegistry();
    registry.forWorld("a").publish({ at: 1, changed: [train], removed: [] });
    expect(registry.forWorld("b").snapshot().trains).toEqual([]);
  });

  it("begrenzt aktive Feeds und entfernt inaktive LRU-Einträge", () => {
    let now = 0;
    const registry = new LivemapRegistry({ maxFeeds: 2, idleTtlMs: 100, now: () => now });
    const unsubscribeA = registry.forWorld("a").subscribe(() => undefined);
    now = 1;
    registry.forWorld("b");
    now = 2;
    registry.forWorld("c");
    expect(registry.peekWorld("a")).toBeDefined();
    expect(registry.peekWorld("b")).toBeUndefined();
    expect(registry.peekWorld("c")).toBeDefined();

    const unsubscribeC = registry.forWorld("c").subscribe(() => undefined);
    expect(() => registry.forWorld("d")).toThrow(LivemapCapacityError);
    unsubscribeA();
    unsubscribeC();
  });

  it("meldet eingefrorene Feeds im Health-Check", async () => {
    let now = 1_000;
    const registry = new LivemapRegistry({ now: () => now });
    registry.forWorld("a").publish({ at: 1, changed: [train], removed: [] });
    now = 62_000;
    await expect(createLivemapHealthCheck(registry, 60_000, () => now).check()).resolves.toMatchObject({
      status: "degraded",
      code: "livemap_stale",
    });
  });
});
