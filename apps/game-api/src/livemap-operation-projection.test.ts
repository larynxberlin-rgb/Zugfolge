import { LivemapRegistry } from "@zugfolge/livemap-stream";
import { describe, expect, it } from "vitest";

import { projectLivemapOperationEvent } from "./livemap-operation-projection.js";

const WORLD = "11111111-1111-4111-8111-111111111111";
const TRAIN = {
  id: "train-1",
  operator: "operator-1",
  trainNumber: "S 101",
  category: "S",
  positionMm: 10,
  speedMmPerSecond: 1,
  delaySeconds: 0,
  nextOperatingPoint: "Leipzig Hbf",
  status: "running",
};

describe("Rust-Betriebsereignisse in der Livemap", () => {
  it("markiert und entfernt Eigenbetrieb ohne Positionen zu erfinden", () => {
    const registry = new LivemapRegistry();
    registry.forWorld(WORLD).publish({ at: 10, changed: [TRAIN], removed: [] });
    projectLivemapOperationEvent(registry, {
      worldId: WORLD,
      eventType: "livemap-operation-marked",
      atS: 10,
      payload: { worldId: WORLD, trainRunIds: [TRAIN.id], marker: "public-operator" },
    });
    expect(registry.forWorld(WORLD).snapshot().trains).toEqual([
      expect.objectContaining({
        id: TRAIN.id,
        positionMm: 10,
        operationMarker: expect.objectContaining({ kind: "public-operator" }),
      }),
    ]);

    projectLivemapOperationEvent(registry, {
      worldId: WORLD,
      eventType: "livemap-operation-cleared",
      atS: 11,
      payload: { worldId: WORLD, trainRunIds: [TRAIN.id], marker: null },
    });
    // The marker changes at second 11; the last position remains a second-10
    // sample until the simulation supplies the next authoritative delta.
    registry.forWorld(WORLD).publish({
      at: 11,
      changed: [{ ...TRAIN, operationMarker: { schemaVersion: "zugfolge-livemap-operation-marker/v1", kind: "public-operator" } }],
      removed: [],
    });
    expect(registry.forWorld(WORLD).snapshot().trains).toEqual([
      expect.not.objectContaining({ operationMarker: expect.anything() }),
    ]);
    expect(registry.forWorld(WORLD).snapshot().trains[0]?.positionMm).toBe(10);
  });

  it("weist weltfremde oder widerspruechliche Markerereignisse ab", () => {
    const registry = new LivemapRegistry();
    expect(() => projectLivemapOperationEvent(registry, {
      worldId: WORLD,
      eventType: "livemap-operation-marked",
      atS: 10,
      payload: { worldId: "other", trainRunIds: [TRAIN.id], marker: "public-operator" },
    })).toThrow(/Weltisolation/);
    expect(() => projectLivemapOperationEvent(registry, {
      worldId: WORLD,
      eventType: "livemap-operation-cleared",
      atS: 10,
      payload: { worldId: WORLD, trainRunIds: [TRAIN.id], marker: "public-operator" },
    })).toThrow(/Markertyp/);
  });
});
