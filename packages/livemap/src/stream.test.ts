import { describe, expect, it, vi } from "vitest";

import {
  createLivemapHealthCheck,
  LivemapCapacityError,
  LivemapFeed,
  LivemapRegistry,
  PUBLIC_OPERATION_MARKER,
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

  it("verbindet Replay und laufenden Fanout atomar", () => {
    const feed = new LivemapFeed("welt-a", 3);
    feed.publish({ at: 10, changed: [train], removed: [] });
    feed.publish({ at: 20, changed: [], removed: [] });
    const listener = vi.fn();

    const subscription = feed.subscribeAfter(1, listener);
    expect(subscription.kind).toBe("resume");
    if (subscription.kind !== "resume") throw new Error("Resume erwartet.");
    expect(subscription.replay.map((delta) => delta.sequence)).toEqual([2]);

    feed.publish({ at: 30, changed: [], removed: [] });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ worldId: "welt-a", sequence: 3 });
    subscription.unsubscribe();
    subscription.unsubscribe();
    expect(feed.subscriberCount).toBe(0);
  });

  it("fordert bei einer Replay-Lücke einen Reset ohne verwaisten Listener", () => {
    const feed = new LivemapFeed("welt-a", 1);
    feed.publish({ at: 10, changed: [train], removed: [] });
    feed.publish({ at: 20, changed: [], removed: [] });
    const listener = vi.fn();

    const subscription = feed.subscribeAfter(0, listener);
    expect(subscription.kind).toBe("reset");
    expect(feed.subscriberCount).toBe(0);
    feed.publish({ at: 30, changed: [], removed: [] });
    expect(listener).not.toHaveBeenCalled();
  });

  it("weist unbrauchbare Puffergrenzen zurück", () => {
    expect(() => new LivemapFeed("welt-a", 0)).toThrow(RangeError);
    expect(() => new LivemapFeed("welt-a", 1.5)).toThrow(RangeError);
  });

  it("merkt Eigenbetrieb vor der ersten echten Position vor", () => {
    const feed = new LivemapFeed("welt-a");

    expect(feed.markPublicOperation(["7"], 20)).toBeUndefined();
    expect(feed.snapshot()).toMatchObject({ sequence: 0, trains: [] });

    const historical = feed.publish({ at: 19, changed: [train], removed: [] });
    expect(historical.changed).toEqual([train]);

    const effective = { ...train, positionMm: 2 };
    const delta = feed.publish({ at: 20, changed: [effective], removed: [] });
    expect(delta.changed).toEqual([{ ...effective, operationMarker: PUBLIC_OPERATION_MARKER }]);
    expect(delta.changed[0]?.positionMm).toBe(effective.positionMm);
  });

  it("wendet vorgemerkte Public- und Clear-Wechsel erst ab ihrem Stichtag an", () => {
    const feed = new LivemapFeed("welt-a");
    feed.markPublicOperation(["7"], 20);
    feed.clearOperationMarker(["7"], 30);

    expect(feed.publish({ at: 19, changed: [train], removed: [] }).changed[0]).toEqual(train);
    expect(feed.publish({ at: 25, changed: [train], removed: [] }).changed[0]).toEqual({
      ...train,
      operationMarker: PUBLIC_OPERATION_MARKER,
    });
    expect(feed.publish({ at: 30, changed: [train], removed: [] }).changed[0]).toEqual(train);
  });

  it("publiziert für bekannte Züge genau ein idempotentes Marker-Delta", () => {
    const feed = new LivemapFeed("welt-a");
    const listener = vi.fn();
    feed.publish({ at: 10, changed: [train], removed: [] });
    feed.subscribe(listener);

    const marked = feed.markPublicOperation(["später", "7", "7"], 10);
    expect(marked).toMatchObject({ sequence: 2, at: 10, removed: [] });
    expect(marked?.changed).toEqual([{ ...train, operationMarker: PUBLIC_OPERATION_MARKER }]);
    expect(feed.snapshot().trains[0]).toMatchObject({
      id: "7",
      positionMm: train.positionMm,
      operationMarker: PUBLIC_OPERATION_MARKER,
    });
    expect(listener).toHaveBeenCalledOnce();

    expect(feed.markPublicOperation(["7"], 10)).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();

    const later = { ...train, id: "später", positionMm: 99 };
    expect(feed.publish({ at: 30, changed: [later], removed: [] }).changed[0]).toEqual({
      ...later,
      operationMarker: PUBLIC_OPERATION_MARKER,
    });
  });

  it("entfernt den Marker sequenziert und verhindert sein Wiederanhaften", () => {
    const feed = new LivemapFeed("welt-a");
    feed.markPublicOperation(["7", "später"], 1);
    feed.publish({ at: 10, changed: [train], removed: [] });

    const cleared = feed.clearOperationMarker(["7", "später"], 10);
    expect(cleared).toMatchObject({ sequence: 2, at: 10 });
    expect(cleared?.changed).toEqual([train]);
    expect(feed.snapshot().trains[0]?.operationMarker).toBeUndefined();

    const staleMarkedTrain = {
      ...train,
      id: "später",
      operationMarker: PUBLIC_OPERATION_MARKER,
    };
    expect(feed.publish({ at: 30, changed: [staleMarkedTrain], removed: [] }).changed[0]).toEqual({
      ...train,
      id: "später",
    });
  });

  it("projiziert einen zukünftigen Marker nicht auf das letzte Positionssample", () => {
    const feed = new LivemapFeed("welt-a");
    feed.publish({ at: 30, changed: [train], removed: [] });

    expect(feed.markPublicOperation(["7"], 40)).toBeUndefined();
    expect(feed.snapshot().trains).toEqual([train]);

    const atBoundary = { ...train, positionMm: 40 };
    expect(feed.publish({ at: 40, changed: [atBoundary], removed: [] }).changed[0]).toEqual({
      ...atBoundary,
      operationMarker: PUBLIC_OPERATION_MARKER,
    });
  });

  it("weist leere Zugmengen, negative Markerzeiten und rückläufige Deltas zurück", () => {
    const feed = new LivemapFeed("welt-a");
    feed.publish({ at: 10, changed: [train], removed: [] });
    expect(() => feed.markPublicOperation([], 10)).toThrow(RangeError);
    expect(() => feed.markPublicOperation(["7"], -1)).toThrow(RangeError);
    expect(() => feed.markPublicOperation([""], 10)).toThrow(RangeError);
    expect(() => feed.publish({ at: 9, changed: [train], removed: [] })).toThrow(RangeError);
  });
});

describe("LivemapRegistry", () => {
  it("isoliert Welten", () => {
    const registry = new LivemapRegistry();
    registry.forWorld("a").publish({ at: 1, changed: [train], removed: [] });
    expect(registry.forWorld("b").snapshot().trains).toEqual([]);
  });

  it("schaltet eine Welt erst durch einen autoritativen Initialsnapshot frei", () => {
    const registry = new LivemapRegistry();
    registry.forWorld("a");
    registry.markPublicOperation("a", ["7"], 1);
    expect(registry.isInitialized("a")).toBe(false);

    const initial = registry.initializeWorld("a", { at: 2, trains: [train] });
    expect(initial.sequence).toBe(1);
    expect(registry.isInitialized("a")).toBe(true);
    expect(registry.isInitialized("b")).toBe(false);
    expect(registry.forWorld("a").snapshot().trains[0]?.operationMarker).toEqual(
      PUBLIC_OPERATION_MARKER,
    );
  });

  it("projiziert persistierte Eigenbetriebsmarker weltisoliert", () => {
    const registry = new LivemapRegistry();
    registry.setOperationMarker("a", ["7"], PUBLIC_OPERATION_MARKER, 1);
    registry.forWorld("a").publish({ at: 2, changed: [train], removed: [] });
    registry.forWorld("b").publish({ at: 2, changed: [train], removed: [] });

    expect(registry.forWorld("a").snapshot().trains[0]?.operationMarker).toEqual(
      PUBLIC_OPERATION_MARKER,
    );
    expect(registry.forWorld("b").snapshot().trains[0]?.operationMarker).toBeUndefined();

    registry.setOperationMarker("a", ["7"], null, 3);
    expect(registry.forWorld("a").snapshot().trains[0]?.operationMarker).toEqual(
      PUBLIC_OPERATION_MARKER,
    );
    registry.forWorld("a").publish({ at: 3, changed: [train], removed: [] });
    expect(registry.forWorld("a").snapshot().trains[0]?.operationMarker).toBeUndefined();
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
