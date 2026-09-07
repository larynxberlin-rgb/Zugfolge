import { describe, expect, it, vi } from "vitest";

import {
  createLivemapHealthCheck,
  LivemapCapacityError,
  LivemapFeed,
  LivemapRegistry,
  PUBLIC_OPERATION_MARKER,
  type PublicInfrastructureDisruption,
  type PublicOperationalRegionFrame,
  type PublicTrain,
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

function operationalFrame(
  commitSequence: number,
  simulationTimeMs: number,
): PublicOperationalRegionFrame {
  return {
    regionId: "east",
    infrastructureReleaseId: "infra:v2",
    commitSequence,
    simulationTimeMs,
    staleAfterMs: simulationTimeMs + 60_000,
    routeLocks: [{
      id: `lock:${commitSequence}`,
      templateId: "route-lock:1",
      trainId: "operational:1",
      resources: ["block:1"],
      releaseAfterTailRouteMm: 20_000,
      lockedAtMs: simulationTimeMs,
    }],
    signals: { "signal:1": "proceed" },
    activeDisruptions: [{
      disruptionId: `disruption:${commitSequence}`,
      effect: { "resource-closed": { resourceId: "block:1" } },
    }],
  };
}

function operationalTrain(
  commitSequence: number,
  simulationTimeMs: number,
  headRouteMm = 10_000,
): PublicTrain {
  return {
    id: "operational:1",
    operatorId: "operator:1",
    operator: "operator:1",
    trainNumber: "RE 1",
    category: "train",
    positionMm: headRouteMm,
    speedMmPerSecond: 0,
    status: "waiting",
    operational: {
      regionId: "east",
      commitSequence,
      simulationTimeMs,
      routeVersionId: "route:v2",
      formationVersionId: "formation:v2",
      movementKind: "train",
      headRouteMm,
      tailRouteMm: headRouteMm - 2_000,
      direction: "along",
      occupiedIntervals: [{ trackId: "edge:1", fromMm: 8_000, toMm: headRouteMm, direction: "along" }],
      occupiedBlocks: ["block:1"],
      authorityEndRouteMm: 20_000,
      waitingReason: "Fahrstrasse",
    },
    mapPosition: {
      infrastructureReleaseId: "infra:v2",
      resourceId: "block:1",
      trackId: "edge:1",
      offsetMm: headRouteMm,
      latitudeE7: 510_000_000,
      longitudeE7: 120_000_000,
      bearingMilliDegrees: 90_000,
    },
  };
}

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
  it("transportiert den Einpunkt-Bremsrest nur mit exakter Abschnittsbindung", () => {
    const train = operationalTrain(7, 1_000);
    const motionSegment = {
      startedAtMs: 1_000, validUntilMs: 1_001, startRouteMm: 10_000,
      startSpeedMmPerSecond: 70, accelerationMmPerSecondSquared: -900,
      authorityEndRouteMm: 20_000, segmentEndRouteMm: 10_000,
      geometry: [{ routeMm: 10_000, trackId: "edge:1", offsetMm: 10_000, latitudeE7: 510_000_000, longitudeE7: 120_000_000 }],
    };
    const publish = (segment: typeof motionSegment) => new LivemapRegistry().initializeRegion("a", "east", {
      at: 1, trains: [{ ...train, operational: { ...train.operational!, motionSegment: segment } }],
      operationalRegions: [operationalFrame(7, 1_000)],
    });
    expect(publish(motionSegment).changed[0]?.operational?.motionSegment?.geometry).toHaveLength(1);
    for (const segment of [
      { ...motionSegment, geometry: [] }, { ...motionSegment, validUntilMs: 1_000 },
      { ...motionSegment, segmentEndRouteMm: 10_001 },
      { ...motionSegment, geometry: [{ ...motionSegment.geometry[0]!, routeMm: 9_999 }] },
    ]) expect(() => publish(segment)).toThrow(/Bewegungsabschnitt/);
  });

  it("publiziert verbundene Kantenwechsel mit beiden Offsets und verwirft Positionssprünge", () => {
    const train = operationalTrain(7, 1_000);
    const motionSegment = {
      startedAtMs: 1_000, validUntilMs: 11_000, startRouteMm: 10_000,
      startSpeedMmPerSecond: 1_000, accelerationMmPerSecondSquared: 0,
      authorityEndRouteMm: 20_000, segmentEndRouteMm: 20_000,
      geometry: [
        { routeMm: 10_000, trackId: "edge:1", offsetMm: 10_000, latitudeE7: 510_000_000, longitudeE7: 120_000_000 },
        { routeMm: 20_000, trackId: "edge:1", offsetMm: 20_000, latitudeE7: 510_010_000, longitudeE7: 120_010_000 },
        { routeMm: 20_000, trackId: "edge:2", offsetMm: 0, latitudeE7: 510_010_000, longitudeE7: 120_010_000 },
      ],
    };
    const exact = { ...train, operational: { ...train.operational!, motionSegment } };
    const registry = new LivemapRegistry();
    expect(registry.initializeRegion("a", "east", {
      at: 1, trains: [exact], operationalRegions: [operationalFrame(7, 1_000)],
    }).changed[0]?.operational?.motionSegment?.geometry).toEqual(motionSegment.geometry);
    for (const geometry of [
      [motionSegment.geometry[0]!, motionSegment.geometry[2]!],
      [motionSegment.geometry[0]!, motionSegment.geometry[1]!, { ...motionSegment.geometry[2]!, latitudeE7: 1 }],
      [motionSegment.geometry[0]!, motionSegment.geometry[0]!, motionSegment.geometry[1]!],
    ]) {
      expect(() => new LivemapRegistry().initializeRegion("a", "east", {
        at: 1, trains: [{ ...exact, operational: { ...exact.operational, motionSegment: { ...motionSegment, geometry } } }],
        operationalRegions: [operationalFrame(7, 1_000)],
      })).toThrow(/Bewegungsabschnitt/);
    }
  });

  it("publiziert v2-Zug und Regionsframe atomar und umgeht den Legacy-Zugprojektor", () => {
    const project = vi.fn(() => {
      throw new Error("Legacy-Projektor darf v2 nicht sehen");
    });
    const registry = new LivemapRegistry({ trainMapProjector: { project } });
    const frame = operationalFrame(7, 1_000);
    const exact = operationalTrain(7, 1_000);

    const delta = registry.initializeRegion("a", "east", {
      at: 1,
      trains: [exact],
      operationalRegions: [frame],
    });

    expect(project).not.toHaveBeenCalled();
    expect(delta.changed).toEqual([exact]);
    expect(delta.changedOperationalRegions).toEqual([frame]);
    expect(registry.initializedWorld("a")?.snapshot()).toMatchObject({
      trains: [exact],
      operationalRegions: [frame],
    });
  });

  it("sendet jeden v2-Zug erneut und bindet ihn strikt an den neuen Regionscommit", () => {
    const registry = new LivemapRegistry();
    registry.initializeRegion("a", "east", {
      at: 1,
      trains: [operationalTrain(7, 1_000)],
      operationalRegions: [operationalFrame(7, 1_000)],
    });

    const next = registry.publishOperationalRegionSnapshot("a", "east", {
      at: 2,
      trains: [operationalTrain(8, 2_000)],
      operationalRegions: [operationalFrame(8, 2_000)],
    });

    expect(next?.changed).toEqual([operationalTrain(8, 2_000)]);
    expect(next?.removed).toEqual([]);
    expect(next?.changedOperationalRegions?.[0]).toMatchObject({
      regionId: "east",
      commitSequence: 8,
      simulationTimeMs: 2_000,
      activeDisruptions: [{ disruptionId: "disruption:8" }],
    });
    expect(registry.initializedWorld("a")?.snapshot().operationalRegions?.[0]?.commitSequence).toBe(8);
    expect(registry.initializedWorld("a")?.snapshot().trains[0]?.operational?.commitSequence).toBe(8);
  });

  it("verwirft einen Zug, dessen Commit oder Release nicht zum Regionsframe gehoert", () => {
    const registry = new LivemapRegistry();
    expect(() => registry.initializeRegion("a", "east", {
      at: 1,
      trains: [operationalTrain(6, 1_000)],
      operationalRegions: [operationalFrame(7, 1_000)],
    })).toThrow(/Regionscommit/);

    expect(() => registry.initializeRegion("b", "east", {
      at: 1,
      trains: [{
        ...operationalTrain(7, 1_000),
        mapPosition: {
          ...operationalTrain(7, 1_000).mapPosition!,
          infrastructureReleaseId: "infra:fremd",
        },
      }],
      operationalRegions: [operationalFrame(7, 1_000)],
    })).toThrow(/committed Regionsframe/);
  });

  it("verwirft einen neuen Regionscommit ohne alle zugehoerigen v2-Zuege", () => {
    const registry = new LivemapRegistry();
    registry.initializeRegion("a", "east", {
      at: 1,
      trains: [operationalTrain(7, 1_000)],
      operationalRegions: [operationalFrame(7, 1_000)],
    });

    expect(() => registry.publishRegionDelta("a", "east", {
      at: 2,
      changed: [],
      removed: [],
      changedOperationalRegions: [operationalFrame(8, 2_000)],
      removedOperationalRegionIds: [],
    })).toThrow(/committed Regionsframe/);
    expect(registry.initializedWorld("a")?.snapshot()).toMatchObject({
      sequence: 1,
      operationalRegions: [{ commitSequence: 7 }],
      trains: [{ operational: { commitSequence: 7 } }],
    });
    expect(() => registry.publishOperationalRegionSnapshot("a", "east", {
      at: 3,
      trains: [operationalTrain(9, 3_000)],
      operationalRegions: [operationalFrame(9, 3_000)],
    })).toThrow(/lueckenlos/);
  });

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

  it("projiziert Aussenlaufnummern im Initialsnapshot und Delta ueber denselben releasegebundenen Port", () => {
    const projectExternal = vi.fn((worldId: string, value: typeof publicExternalTrain) => ({
      ...value,
      trainNumber: `${worldId}-35000`,
    }));
    const registry = new LivemapRegistry({
      trainMapProjector: { project: (_worldId, value) => value, projectExternal },
    });
    registry.initializeRegion("a", "east", {
      at: 1,
      trains: [],
      externalTrains: [publicExternalTrain],
    });
    registry.publishRegionDelta("a", "east", {
      at: 2,
      changed: [],
      removed: [],
      changedExternalTrains: [{ ...publicExternalTrain, progressBasisPoints: 6_000 }],
      removedExternalTrainIds: [],
    });
    expect(projectExternal).toHaveBeenCalledTimes(2);
    expect(registry.initializedWorld("a")?.snapshot().externalTrains).toEqual([
      expect.objectContaining({ trainNumber: "a-35000", progressBasisPoints: 6_000 }),
    ]);
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
    const feed = registry.initializedWorld("a")!;
    const reset = vi.fn();
    const cursor = feed.snapshot();
    const subscription = feed.subscribeAfter(cursor, vi.fn(), reset);
    expect(subscription.kind).toBe("resume");
    registry.markUnavailable("a");
    expect(registry.isInitialized("a")).toBe(false);
    expect(reset).toHaveBeenCalledOnce();
    expect(feed.subscriberCount).toBe(0);
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
    registry.markPublicOperation("released-world", ["released-world-run"], 0);
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

  it("meldet einen erwarteten fehlenden oder invalidierten Feed als down", async () => {
    let now = 1_000;
    const registry = new LivemapRegistry({ now: () => now });
    const health = createLivemapHealthCheck(
      registry,
      60_000,
      () => now,
      () => true,
      () => ["running"],
    );

    await expect(health.check()).resolves.toMatchObject({
      status: "down",
      code: "livemap_missing",
      detail: "1/1 erwartete Feeds fehlen",
    });
    registry.initializeWorld("running", { at: 1, trains: [train] });
    await expect(health.check()).resolves.toMatchObject({
      status: "ok",
      code: "livemap_fresh",
    });

    registry.markUnavailable("running");
    await expect(health.check()).resolves.toMatchObject({
      status: "down",
      code: "livemap_missing",
    });
  });
});
