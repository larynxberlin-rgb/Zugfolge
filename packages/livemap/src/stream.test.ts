import { describe, expect, it, vi } from "vitest";

import {
  createLivemapHealthCheck,
  LivemapCapacityError,
  LivemapFeed,
  LivemapRegistry,
  PUBLIC_OPERATION_MARKER,
  type PublicInfrastructureDisruption,
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

const externalTrain = {
  id: "7",
  operator: "EVU",
  trainNumber: "RE 7",
  category: "regional",
  journeyChainId: "chain-re7",
  externalLegId: "chain-re7:external:1",
  fromPortalId: "portal-eisenach",
  toPortalId: "portal-eisenach",
  scheduledEndS: 100,
  reentryEarliestS: 90,
  reentryLatestS: 110,
  delaySeconds: 0,
  fixedCostCents: "5000",
  boundVehicleIds: ["vehicle-7"],
  boundPersonnelDutyIds: ["duty-7"],
  status: "outside" as const,
  progressBasisPoints: 5_000,
};

const publicExternalTrain = {
  id: externalTrain.id,
  operator: externalTrain.operator,
  trainNumber: externalTrain.trainNumber,
  category: externalTrain.category,
  journeyChainId: externalTrain.journeyChainId,
  externalLegId: externalTrain.externalLegId,
  fromPortalId: externalTrain.fromPortalId,
  toPortalId: externalTrain.toPortalId,
  scheduledEndS: externalTrain.scheduledEndS,
  reentryEarliestS: externalTrain.reentryEarliestS,
  reentryLatestS: externalTrain.reentryLatestS,
  delaySeconds: externalTrain.delaySeconds,
  status: externalTrain.status,
  progressBasisPoints: externalTrain.progressBasisPoints,
};

const infrastructureDisruption = {
  schemaVersion: "zugfolge-livemap-disruption/v1" as const,
  disruptionId: "closure-1",
  causeCode: 26,
  causeLabel: "Infrastruktur",
  fineCauseId: "track.failure",
  fineCauseLabel: "Gleisstoerung",
  effect: "closure" as const,
  affectedResource: "resource-1",
  validUntilS: 500,
  kind: "unplanned" as const,
  positionMm: 0,
  publishedAtS: 1,
  startsAtS: 1,
};

describe("LivemapFeed", () => {
  it("ordnet nicht-ASCII-Zugkennungen wie Rust nach UTF-8-Bytes", () => {
    const feed = new LivemapFeed("welt-a");
    feed.publish({
      at: 1,
      changed: [
        { ...train, id: "ä" },
        { ...train, id: "z" },
      ],
      removed: [],
    });

    expect(feed.snapshot().trains.map((item) => item.id)).toEqual(["z", "ä"]);
  });

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

  it("publiziert den Aussenlauf getrennt von Kartenpositionen bis zur bestaetigten Wiedereinfahrt", () => {
    const feed = new LivemapFeed("welt-a");
    const entered = feed.publish({
      at: 10,
      changed: [],
      removed: [],
      changedExternalTrains: [externalTrain],
      removedExternalTrainIds: [],
    });
    expect(entered.changedExternalTrains).toEqual([publicExternalTrain]);
    expect(feed.snapshot().trains).toEqual([]);
    expect(feed.snapshot().externalTrains).toEqual([publicExternalTrain]);

    feed.publish({
      at: 20,
      changed: [train],
      removed: [],
      changedExternalTrains: [],
      removedExternalTrainIds: ["7"],
    });
    expect(feed.snapshot().externalTrains).toEqual([]);
    expect(feed.snapshot().trains).toEqual([train]);
  });

  it("publiziert nur sparse Infrastrukturabweichungen und ganzzahlige Kartenpositionen", () => {
    const feed = new LivemapFeed("welt-a");
    feed.publish({
      at: 10,
      changed: [{
        ...train,
        mapPosition: {
          infrastructureReleaseId: "infra-de-2026",
          resourceId: "block-track-7",
          trackId: "track-7",
          offsetMm: 1,
          latitudeE7: 515_000_000,
          longitudeE7: 120_000_000,
        },
      }],
      removed: [],
      changedObjectStates: [{
        id: "track:track-7",
        objectKind: "track",
        objectId: "track-7",
        state: "construction",
      }],
      removedObjectStateIds: [],
    });
    expect(feed.snapshot()).toMatchObject({
      trains: [{ mapPosition: { trackId: "track-7", offsetMm: 1 } }],
      objectStates: [{ id: "track:track-7", state: "construction" }],
    });

    feed.publish({
      at: 11,
      changed: [],
      removed: [],
      changedObjectStates: [],
      removedObjectStateIds: ["track:track-7"],
    });
    expect(feed.snapshot().objectStates).toEqual([]);
  });

  it("publiziert eine Kartenschaetzung getrennt von der bestaetigten Gleisposition", () => {
    const feed = new LivemapFeed("welt-a");
    feed.publish({
      at: 10,
      changed: [{
        ...train,
        mapEstimate: {
          infrastructureReleaseId: "infra-de-2026",
          resourceId: "block-track-7",
          method: "route-corridor",
          displayPathId: "corridor-re7",
          displayOffsetMm: 25_000,
          latitudeE7: 515_000_000,
          longitudeE7: 120_000_000,
          bearingMilliDegrees: 90_000,
          uncertaintyMm: 750_000,
        },
      }],
      removed: [],
    });

    expect(feed.snapshot().trains[0]).toMatchObject({
      mapEstimate: {
        method: "route-corridor",
        displayPathId: "corridor-re7",
        uncertaintyMm: 750_000,
      },
    });
    expect(feed.snapshot().trains[0]).not.toHaveProperty("mapPosition");
  });

  it("weist ungueltige Kartenpositionen und nicht-sparse Normalzustaende zurueck", () => {
    const feed = new LivemapFeed("welt-a");
    expect(() => feed.publish({
      at: 1,
      changed: [{ ...train, mapPosition: { infrastructureReleaseId: "infra-de-2026", resourceId: "block-track-7", trackId: "track-7", offsetMm: 1.5, latitudeE7: 0, longitudeE7: 0 } }],
      removed: [],
    })).toThrow(/Kartenposition/);
    expect(() => feed.publish({
      at: 1,
      changed: [],
      removed: [],
      changedObjectStates: [{
        id: "track:track-7",
        objectKind: "track",
        objectId: "track-7",
        state: "normal",
      } as never],
      removedObjectStateIds: [],
    })).toThrow(/sparsamen v1-Vertrag/);
  });

  it("weist widerspruechliche oder ungueltige Kartenschaetzungen zurueck", () => {
    const feed = new LivemapFeed("welt-a");
    const mapEstimate = {
      infrastructureReleaseId: "infra-de-2026",
      resourceId: "block-track-7",
      method: "anchor-hold" as const,
      displayPathId: "anchor-track-7",
      displayOffsetMm: 1,
      latitudeE7: 515_000_000,
      longitudeE7: 120_000_000,
      uncertaintyMm: 500_000,
    };
    expect(() => feed.publish({
      at: 1,
      changed: [{
        ...train,
        mapPosition: {
          infrastructureReleaseId: "infra-de-2026",
          resourceId: "block-track-7",
          trackId: "track-7",
          offsetMm: 1,
          latitudeE7: 515_000_000,
          longitudeE7: 120_000_000,
        },
        mapEstimate,
      }],
      removed: [],
    })).toThrow(/nicht zugleich/);
    expect(() => feed.publish({
      at: 1,
      changed: [{ ...train, mapEstimate: { ...mapEstimate, uncertaintyMm: -1 } }],
      removed: [],
    })).toThrow(/Kartenschaetzung/);
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

    const subscription = feed.subscribeAfter(
      { streamId: feed.snapshot().streamId, sequence: 1 },
      listener,
    );
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

    const subscription = feed.subscribeAfter(
      { streamId: feed.snapshot().streamId, sequence: 0 },
      listener,
    );
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

  it("überträgt den Eigenbetriebsmarker von der Basisfahrt auf Tagesinstanzen", () => {
    const feed = new LivemapFeed("welt-a");
    feed.markPublicOperation(["7"], 20);
    const repeated = { ...train, id: "7:day-1", baseTrainRunId: "7" };
    expect(feed.publish({ at: 20, changed: [repeated], removed: [] }).changed[0]).toEqual({
      ...repeated,
      operationMarker: PUBLIC_OPERATION_MARKER,
    });
    expect(feed.clearOperationMarker(["7"], 20)?.changed).toEqual([repeated]);
    expect(feed.markPublicOperation(["7"], 20)?.changed).toEqual([{
      ...repeated,
      operationMarker: PUBLIC_OPERATION_MARKER,
    }]);
    const unrelated = { ...train, id: "7:day-2", baseTrainRunId: "unknown" };
    expect(feed.publish({ at: 21, changed: [unrelated], removed: [] }).changed[0]).toEqual(unrelated);
  });

  it("bewahrt gezielte Marker einer Tagesinstanz auch bei späteren Samples", () => {
    const feed = new LivemapFeed("welt-a");
    const repeated = { ...train, id: "7:day-1", baseTrainRunId: "7" };
    feed.publish({ at: 20, changed: [repeated], removed: [] });

    expect(feed.markPublicOperation(["7:day-1"], 20)?.changed[0]).toEqual({
      ...repeated,
      operationMarker: PUBLIC_OPERATION_MARKER,
    });
    expect(feed.publish({ at: 21, changed: [repeated], removed: [] }).changed[0]).toEqual({
      ...repeated,
      operationMarker: PUBLIC_OPERATION_MARKER,
    });
    feed.clearOperationMarker(["7:day-1"], 22);
    expect(feed.publish({ at: 22, changed: [repeated], removed: [] }).changed[0]).toEqual(repeated);
  });

  it("verwirft eine frei erfundene Basisbindung fuer Eigenbetriebsmarker", () => {
    const feed = new LivemapFeed("welt-a");
    feed.markPublicOperation(["7"], 20);
    const forged = { ...train, id: "forged", baseTrainRunId: "7" };
    expect(feed.publish({ at: 20, changed: [forged], removed: [] }).changed[0]).toEqual(forged);
    expect(feed.markPublicOperation(["7"], 20)).toBeUndefined();
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
  it("leitet Gleisfarben aus Ressourcenstoerungen ab und entfernt sie wieder", () => {
    const projectDisruption = vi.fn((_worldId: string, disruption: PublicInfrastructureDisruption) =>
      disruption.effect === "closure"
        ? [{
          id: `disruption:${disruption.disruptionId}:track:track-1`,
          objectKind: "track" as const,
          objectId: "track-1",
          state: "closure" as const,
          disruptionId: disruption.disruptionId,
          validUntilS: disruption.validUntilS,
        }]
        : []);
    const registry = new LivemapRegistry({ objectStateProjector: { projectDisruption } });
    registry.initializeRegion("a", "east", { at: 1, trains: [], disruptions: [infrastructureDisruption] });
    expect(registry.initializedWorld("a")?.snapshot().objectStates).toEqual([
      expect.objectContaining({ objectId: "track-1", state: "closure", disruptionId: "closure-1" }),
    ]);

    const removed = registry.publishRegionDelta("a", "east", {
      at: 2,
      changed: [],
      removed: [],
      changedDisruptions: [],
      removedDisruptionIds: [infrastructureDisruption.disruptionId],
    });
    expect(removed?.removedObjectStateIds).toEqual(["disruption:closure-1:track:track-1"]);
    expect(registry.initializedWorld("a")?.snapshot().objectStates).toEqual([]);
  });

  it("projiziert Initialsnapshot und Delta nur ueber den releasegebundenen Kartenport", () => {
    const project = vi.fn((worldId: string, value: typeof train) => ({
      ...value,
      mapPosition: {
        infrastructureReleaseId: `infra-${worldId}`,
        resourceId: "resource-1",
        trackId: "track-1",
        offsetMm: value.positionMm,
        latitudeE7: 500_000_000,
        longitudeE7: 100_000_000,
      },
    }));
    const registry = new LivemapRegistry({ trainMapProjector: { project } });
    registry.initializeRegion("a", "east", { at: 1, trains: [train] });
    registry.publishRegionDelta("a", "east", { at: 2, changed: [{ ...train, positionMm: 20 }], removed: [] });
    expect(project).toHaveBeenCalledTimes(2);
    expect(registry.initializedWorld("a")?.snapshot().trains[0]?.mapPosition).toMatchObject({
      infrastructureReleaseId: "infra-a",
      offsetMm: 20,
    });
  });

  it("akzeptiert sparse Zustandsabweichungen fuer den sichtbaren Bahnkontext", () => {
    const registry = new LivemapRegistry();
    registry.initializeRegion("a", "east", {
      at: 1,
      trains: [],
      objectStates: [{ id: "context-1", objectKind: "rail-context", objectId: "context-1", state: "closure" }],
    });
    expect(registry.initializedWorld("a")?.snapshot().objectStates).toEqual([
      { id: "context-1", objectKind: "rail-context", objectId: "context-1", state: "closure" },
    ]);
  });

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
    registry.markUnavailable("a");
    expect(registry.isInitialized("a")).toBe(false);
  });

  it("entfernt eine archivierte Welt samt Betriebsmarkern idempotent", () => {
    const registry = new LivemapRegistry();
    registry.markPublicOperation("a", ["7"], 1);
    registry.initializeWorld("a", { at: 2, trains: [train] });
    expect(registry.initializedWorld("a")?.snapshot().trains[0]?.operationMarker)
      .toEqual(PUBLIC_OPERATION_MARKER);

    registry.releaseWorld("a");
    registry.releaseWorld("a");

    expect(registry.size).toBe(0);
    expect(registry.isInitialized("a")).toBe(false);
    expect(registry.peekWorld("a")).toBeUndefined();
    registry.initializeWorld("a", { at: 3, trains: [train] });
    expect(registry.initializedWorld("a")?.snapshot().trains[0]?.operationMarker)
      .toBeUndefined();
  });

  it("liefert nach TTL-Ablauf niemals einen neu erzeugten leeren Initialfeed", () => {
    let now = 0;
    const registry = new LivemapRegistry({ idleTtlMs: 100, now: () => now });
    registry.initializeWorld("a", { at: 1, trains: [train] });
    expect(registry.initializedWorld("a")?.snapshot().trains).toHaveLength(1);

    now = 101;
    expect(registry.initializedWorld("a")).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it("erzwingt nach TTL bei gleicher Sequenz und neuer Generation einen Reset", () => {
    let now = 0;
    const streamIds = ["generation-a", "generation-b"];
    const registry = new LivemapRegistry({
      idleTtlMs: 100,
      now: () => now,
      createStreamId: () => streamIds.shift()!,
    });
    registry.initializeRegion("a", "east", { at: 1, trains: [train] });
    const before = registry.initializedWorld("a")!.snapshot();

    now = 101;
    registry.initializeRegion("a", "east", {
      at: 2,
      trains: [{ ...train, positionMm: 999 }],
    });
    const feed = registry.initializedWorld("a")!;
    const after = feed.snapshot();
    expect({ before: before.sequence, after: after.sequence }).toEqual({
      before: 1,
      after: 1,
    });
    expect(after.streamId).not.toBe(before.streamId);
    expect(after.trains[0]?.positionMm).toBe(999);
    expect(
      feed.subscribeAfter(
        { streamId: before.streamId, sequence: before.sequence },
        vi.fn(),
      ).kind,
    ).toBe("reset");
  });

  it("bewahrt vorgemerkte Betriebsmarker ueber Feed-Eviction und Restore", () => {
    let now = 0;
    const registry = new LivemapRegistry({ idleTtlMs: 100, now: () => now });
    registry.markPublicOperation("a", ["7"], 1);
    registry.clearOperationMarker("a", ["7"], 1);
    registry.markPublicOperation("a", ["7"], 1);
    registry.initializeRegion("a", "east", { at: 2, trains: [train] });
    expect(registry.initializedWorld("a")?.snapshot().trains[0]?.operationMarker).toEqual(
      PUBLIC_OPERATION_MARKER,
    );

    now = 101;
    expect(registry.initializedWorld("a")).toBeUndefined();
    registry.initializeRegion("a", "east", { at: 3, trains: [train] });
    expect(registry.initializedWorld("a")?.snapshot().trains[0]?.operationMarker).toEqual(
      PUBLIC_OPERATION_MARKER,
    );

    registry.clearOperationMarker("a", ["7"], 4);
    now = 202;
    expect(registry.initializedWorld("a")).toBeUndefined();
    registry.initializeRegion("a", "east", { at: 5, trains: [train] });
    expect(
      registry.initializedWorld("a")?.snapshot().trains[0]?.operationMarker,
    ).toBeUndefined();
  });

  it("restauriert Zuege regiongebunden und entfernt keine Nachbarregion", () => {
    const registry = new LivemapRegistry();
    const east = { ...train, id: "east" };
    const west = { ...train, id: "west" };
    const addedLater = { ...train, id: "east-later" };
    registry.initializeRegion("a", "east", { at: 1, trains: [east] });
    registry.initializeRegion("a", "west", { at: 1, trains: [west] });
    registry.publishRegionDelta("a", "east", {
      at: 2,
      changed: [addedLater],
      removed: ["east"],
    });
    expect(
      registry.initializedWorld("a")?.snapshot().trains.map((item) => item.id),
    ).toEqual(["east-later", "west"]);

    registry.markUnavailable("a");
    registry.initializeRegion("a", "east", { at: 2, trains: [] });
    expect(
      registry.initializedWorld("a")?.snapshot().trains.map((item) => item.id),
    ).toEqual(["west"]);
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

  it("wertet nur registrierte, bereits gestartete Echtzeitwelten als freshness-pflichtig", async () => {
    let now = 1_000;
    const registry = new LivemapRegistry({ now: () => now });
    registry.markPublicOperation("tutorial", ["tutorial-run"], 0);
    registry.forWorld("epoch-less");
    registry.forWorld("future");
    registry.forWorld("running").publish({ at: 1, changed: [train], removed: [] });
    const realtimeWorlds = new Set(["future", "running"]);
    const epochs = new Map([
      ["future", 120_000],
      ["running", 0],
    ]);
    const isExpectedFresh = (worldId: string, nowMs: number) =>
      realtimeWorlds.has(worldId) && (epochs.get(worldId) ?? Number.POSITIVE_INFINITY) <= nowMs;
    now = 62_000;

    await expect(createLivemapHealthCheck(
      registry,
      60_000,
      () => now,
      isExpectedFresh,
    ).check()).resolves.toMatchObject({
      status: "degraded",
      code: "livemap_stale",
      detail: expect.stringContaining("1/1"),
    });

    now = 62_001;
    registry.forWorld("running").publish({ at: 2, changed: [train], removed: [] });
    await expect(createLivemapHealthCheck(
      registry,
      60_000,
      () => now,
      isExpectedFresh,
    ).check()).resolves.toMatchObject({ status: "ok", code: "livemap_fresh" });
  });
});
