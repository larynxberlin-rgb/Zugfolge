import { describe, expect, it } from "vitest";

import type { PublicOperationalRegionFrame } from "@zugfolge/livemap-stream";

import {
  applyDelta,
  initialState,
  latestTrainRenderAt,
  nextTrainFreezeAt,
  parseDelta,
  parseSnapshot,
  renderTrains,
  type PublicTrain,
} from "./protocol.js";

const exactTrain: PublicTrain = {
  id: "train:1",
  operator: "EVU",
  trainNumber: "RB 1",
  category: "regional",
  positionMm: 0,
  speedMmPerSecond: 1_000,
  delaySeconds: 0,
  nextOperatingPoint: "Leipzig Hbf",
  status: "running",
  mapPosition: {
    infrastructureReleaseId: "infra:v2",
    resourceId: "block:1",
    trackId: "track:1",
    offsetMm: 0,
    latitudeE7: 510_000_000,
    longitudeE7: 120_000_000,
  },
  operational: {
    regionId: "region:1",
    commitSequence: 7,
    simulationTimeMs: 1_000,
    routeVersionId: "route:v1",
    formationVersionId: "formation:v1",
    movementKind: "train",
    headRouteMm: 0,
    tailRouteMm: -20_000,
    direction: "along",
    occupiedIntervals: [],
    occupiedBlocks: ["block:1"],
    authorityEndRouteMm: 5_000,
    motionSegment: {
      startedAtMs: 1_000,
      validUntilMs: 3_000,
      startRouteMm: 0,
      startSpeedMmPerSecond: 1_000,
      accelerationMmPerSecondSquared: 0,
      authorityEndRouteMm: 5_000,
      segmentEndRouteMm: 2_000,
      geometry: [
        { routeMm: 0, trackId: "track:1", offsetMm: 0, latitudeE7: 510_000_000, longitudeE7: 120_000_000 },
        { routeMm: 5_000, trackId: "track:1", offsetMm: 5_000, latitudeE7: 510_005_000, longitudeE7: 120_005_000 },
      ],
    },
  },
};

function frame(
  commitSequence = 7,
  simulationTimeMs = 1_000,
  staleAfterMs = 3_000,
): PublicOperationalRegionFrame {
  return {
    regionId: "region:1",
    infrastructureReleaseId: "infra:v2",
    commitSequence,
    simulationTimeMs,
    staleAfterMs,
    routeLocks: [{
      id: "lock:1",
      templateId: "route-lock:1",
      trainId: "train:1",
      resources: ["block:1"],
      releaseAfterTailRouteMm: 5_000,
      lockedAtMs: simulationTimeMs,
    }],
    signals: { "signal:1": "proceed" },
    activeDisruptions: [{
      disruptionId: "disruption:1",
      effect: { "resource-closed": { resourceId: "block:1" } },
    }],
  };
}

function state(at: number) {
  return initialState({
    worldId: "world:1",
    streamId: "stream:1",
    sequence: 7,
    at,
    trains: [exactTrain],
    operationalRegions: [frame()],
  });
}

describe("autorisierte Bewegungsabschnitte", () => {
  it("wechselt am exakten Kantenende auf den neuen Gleisoffset und fährt gegen dessen Kilometrierung weiter", () => {
    const train: PublicTrain = {
      ...exactTrain,
      operational: {
        ...exactTrain.operational!,
        motionSegment: {
          ...exactTrain.operational!.motionSegment!,
          geometry: [
            { routeMm: 0, trackId: "track:1", offsetMm: 9_000, latitudeE7: 510_000_000, longitudeE7: 120_000_000 },
            { routeMm: 1_000, trackId: "track:1", offsetMm: 10_000, latitudeE7: 510_001_000, longitudeE7: 120_001_000 },
            { routeMm: 1_000, trackId: "track:2", offsetMm: 40_000, latitudeE7: 510_001_000, longitudeE7: 120_001_000 },
            { routeMm: 2_000, trackId: "track:2", offsetMm: 39_000, latitudeE7: 510_002_000, longitudeE7: 120_002_000 },
            { routeMm: 2_000, trackId: "track:3", offsetMm: 0, latitudeE7: 510_002_000, longitudeE7: 120_002_000 },
          ],
        },
      },
    };
    const current = initialState(parseSnapshot({
      worldId: "world:1", streamId: "stream-1", sequence: 7, at: 1,
      trains: [train], operationalRegions: [frame()],
    }));
    const samples = { previous: current, current };
    expect(renderTrains(samples, 1.5)[0]?.mapPosition).toMatchObject({ trackId: "track:1", offsetMm: 9_500 });
    expect(renderTrains(samples, 2)[0]?.mapPosition).toMatchObject({ trackId: "track:2", offsetMm: 40_000 });
    expect(renderTrains(samples, 2.5)[0]?.mapPosition).toMatchObject({ trackId: "track:2", offsetMm: 39_500 });
    expect(renderTrains(samples, 30)[0]).toMatchObject({ positionFrozen: true, mapPosition: { trackId: "track:3", offsetMm: 0 } });
  });

  it("setzt Millisekundencommits beim sekundenbasierten Snapshot nicht zurück", () => {
    const train: PublicTrain = {
      ...exactTrain,
      positionMm: 500,
      operational: { ...exactTrain.operational!, simulationTimeMs: 1_500, headRouteMm: 500, tailRouteMm: -19_500 },
    };
    const current = initialState({
      worldId: "world:1", streamId: "stream-1", sequence: 7, at: 1,
      trains: [train], operationalRegions: [frame(7, 1_500, 3_000)],
    });
    expect(renderTrains({ previous: current, current }, 1)[0]).toMatchObject({
      positionMm: 500, operational: { simulationTimeMs: 1_500, tailRouteMm: -19_500 },
    });
  });

  it("beendet die Animation am Bewegungsende statt erst am Ende der Transporttoleranz", () => {
    const current = initialState({
      worldId: "world:1", streamId: "stream-1", sequence: 7, at: 1,
      trains: [exactTrain], operationalRegions: [frame(7, 1_000, 76_000)],
    });
    expect(latestTrainRenderAt(current)).toBe(3);
    expect(latestTrainRenderAt({ ...current, operationalRegions: new Map([["region:1", frame(7, 1_000, 2_000)]]) })).toBe(2);
    expect(latestTrainRenderAt({ ...current, trains: new Map() })).toBe(1);
    const { motionSegment: _segment, ...standing } = exactTrain.operational!;
    const stationary = { ...current, trains: new Map([[exactTrain.id, { ...exactTrain, operational: standing }]]) };
    expect(latestTrainRenderAt(stationary)).toBe(1);
    expect(nextTrainFreezeAt(stationary, 1)).toBe(76);
    expect(nextTrainFreezeAt(stationary, 76)).toBeUndefined();
    expect(renderTrains({ previous: stationary, current: stationary }, 76)[0]?.positionFrozen).toBe(true);
    expect(renderTrains({ previous: current, current }, 1, 76)[0]).toMatchObject({ positionMm: 0, positionFrozen: true });
    expect(renderTrains({ previous: current, current }, 2)[0]?.positionFrozen).toBe(false);
    expect(renderTrains({ previous: current, current }, 3)[0]?.positionFrozen).toBe(true);
  });

  it("verwirft Geometrielücken und ungültige Koordinaten vor der Darstellung", () => {
    const first = exactTrain.operational!.motionSegment!.geometry[0]!;
    const last = exactTrain.operational!.motionSegment!.geometry[1]!;
    for (const geometry of [
      [first, { ...last, trackId: "track:2" }],
      [first, { ...first } , last],
      [first, { ...first, trackId: "track:2", latitudeE7: first.latitudeE7 + 1 }, { ...last, trackId: "track:2" }],
      [first, { ...last, longitudeE7: 1_800_000_001 }],
      [first, { ...last, bearingMilliDegrees: 360_000 }],
      [first, { ...last, routeMm: 1_000 }],
    ]) {
      expect(() => parseSnapshot({
        worldId: "world:1", streamId: "stream-1", sequence: 7, at: 1,
        trains: [{ ...exactTrain, operational: { ...exactTrain.operational, motionSegment: { ...exactTrain.operational!.motionSegment, geometry } } }],
        operationalRegions: [frame()],
      })).toThrow(/Laufweggeometrie/);
    }
  });

  it("interpoliert analytisch bis valid_until und friert danach exakt ein", () => {
    const current = state(1);
    const samples = { previous: current, current };
    expect(renderTrains(samples, 1)[0]?.positionMm).toBe(0);
    expect(renderTrains(samples, 1)[0]?.speedMmPerSecond).toBe(1_000);
    expect(renderTrains(samples, 2)[0]?.positionMm).toBe(1_000);
    expect(renderTrains(samples, 30)[0]?.positionMm).toBe(2_000);
    expect(renderTrains(samples, 30)[0]?.speedMmPerSecond).toBe(1_000);
    expect(renderTrains(samples, 30)[0]?.operational?.simulationTimeMs).toBe(3_000);
  });

  it("loest nur den terminalen Millimeter wie der Rust-Kern auf", () => {
    const terminalMillimetre: PublicTrain = {
      ...exactTrain,
      operational: {
        ...exactTrain.operational!,
        motionSegment: {
          ...exactTrain.operational!.motionSegment!,
          validUntilMs: 1_002,
          startSpeedMmPerSecond: 1,
          accelerationMmPerSecondSquared: -900,
          authorityEndRouteMm: 1,
          segmentEndRouteMm: 1,
          geometry: [
            { routeMm: 0, trackId: "track:1", offsetMm: 0, latitudeE7: 510_000_000, longitudeE7: 120_000_000 },
            { routeMm: 1, trackId: "track:1", offsetMm: 1, latitudeE7: 510_000_001, longitudeE7: 120_000_001 },
          ],
        },
      },
    };
    const terminalState = initialState({
      worldId: "world:1", streamId: "stream:1", sequence: 7, at: 1,
      trains: [terminalMillimetre], operationalRegions: [frame(7, 1_000, 2_000)],
    });
    const samples = { previous: terminalState, current: terminalState };

    expect(renderTrains(samples, 1.001)[0]?.positionMm).toBe(0);
    expect(renderTrains(samples, 1.002)[0]?.positionMm).toBe(1);
    expect(renderTrains(samples, 1.002)[0]?.speedMmPerSecond).toBe(0);
  });

  it("springt weder Nullzeit- noch groessere Nullfortschrittsabschnitte", () => {
    const noProgress = (validUntilMs: number, segmentEndRouteMm: number): PublicTrain => ({
      ...exactTrain,
      operational: {
        ...exactTrain.operational!,
        motionSegment: {
          ...exactTrain.operational!.motionSegment!,
          validUntilMs,
          startSpeedMmPerSecond: 1,
          accelerationMmPerSecondSquared: -900,
          authorityEndRouteMm: segmentEndRouteMm,
          segmentEndRouteMm,
        },
      },
    });
    const zeroDuration = initialState({
      worldId: "world:1", streamId: "stream:1", sequence: 7, at: 1,
      trains: [noProgress(1_000, 1)], operationalRegions: [frame(7, 1_000, 2_000)],
    });
    const twoMillimetres = initialState({
      worldId: "world:1", streamId: "stream:1", sequence: 7, at: 1,
      trains: [noProgress(1_002, 2)], operationalRegions: [frame(7, 1_000, 2_000)],
    });

    expect(renderTrains({ previous: zeroDuration, current: zeroDuration }, 2)[0]?.positionMm).toBe(0);
    expect(renderTrains({ previous: twoMillimetres, current: twoMillimetres }, 1.002)[0]?.positionMm).toBe(0);
  });

  it("ueberschreitet auch im Browser nie die naechste operative Ereignisgrenze", () => {
    const current = state(1);
    const accelerated: PublicTrain = {
      ...exactTrain,
      operational: {
        ...exactTrain.operational!,
        motionSegment: {
          ...exactTrain.operational!.motionSegment!,
          startSpeedMmPerSecond: 50_000,
        },
      },
    };
    const acceleratedState = initialState({
      worldId: "world:1", streamId: "stream:1", sequence: 7, at: 1, trains: [accelerated], operationalRegions: [frame()],
    });
    expect(renderTrains({ previous: current, current: acceleratedState }, 3)[0]?.positionMm).toBe(2_000);
  });

  it("ueberschreitet auch bei fehlerhafter Beschleunigung nie die Fahrberechtigung", () => {
    const current = state(1);
    const accelerated: PublicTrain = {
      ...exactTrain,
      operational: {
        ...exactTrain.operational!,
        motionSegment: {
          ...exactTrain.operational!.motionSegment!,
          startSpeedMmPerSecond: 50_000,
          segmentEndRouteMm: 5_000,
        },
      },
    };
    const acceleratedState = initialState({
      worldId: "world:1", streamId: "stream:1", sequence: 7, at: 1, trains: [accelerated], operationalRegions: [frame()],
    });
    expect(renderTrains({ previous: current, current: acceleratedState }, 3)[0]?.positionMm).toBe(5_000);
  });

  it("rundet einen negativen halben Beschleunigungsweg wie Rust von null weg", () => {
    const current = state(1);
    const braking: PublicTrain = {
      ...exactTrain,
      operational: {
        ...exactTrain.operational!,
        motionSegment: {
          ...exactTrain.operational!.motionSegment!,
          startSpeedMmPerSecond: 1,
          accelerationMmPerSecondSquared: -1,
          validUntilMs: 2_000,
          segmentEndRouteMm: 5_000,
        },
      },
    };
    const brakingState = initialState({
      worldId: "world:1", streamId: "stream:1", sequence: 7, at: 1,
      trains: [braking], operationalRegions: [frame(7, 1_000, 2_000)],
    });

    const rendered = renderTrains({ previous: current, current: brakingState }, 2)[0]!;
    expect(rendered.positionMm).toBe(0);
    expect(rendered.speedMmPerSecond).toBe(0);
  });

  it("friert jede Region an ihrer eigenen staleAfterMs-Grenze ein", () => {
    const frozen = initialState({
      worldId: "world:1",
      streamId: "stream:1",
      sequence: 7,
      at: 1,
      trains: [exactTrain],
      operationalRegions: [frame(7, 1_000, 2_000)],
    });
    const rendered = renderTrains({ previous: frozen, current: frozen }, 30)[0]!;
    expect(rendered.positionMm).toBe(1_000);
    expect(rendered.operational?.simulationTimeMs).toBe(2_000);
  });

  it("verwirft falsche Region, InfraRelease und Commitbindung", () => {
    expect(() => initialState({
      worldId: "world:1", streamId: "stream-1", sequence: 7, at: 1,
      trains: [exactTrain], operationalRegions: [{ ...frame(), commitSequence: 8 }],
    })).toThrow(/atomar/);
    expect(() => initialState({
      worldId: "world:1", streamId: "stream:1", sequence: 7, at: 1,
      trains: [exactTrain], operationalRegions: [{ ...frame(), regionId: "region:2" }],
    })).toThrow(/atomar/);
    expect(() => initialState({
      worldId: "world:1", streamId: "stream:1", sequence: 7, at: 1,
      trains: [exactTrain], operationalRegions: [{ ...frame(), infrastructureReleaseId: "infra:fremd" }],
    })).toThrow(/atomar/);
  });

  it("fordert lueckenlose Regionscommits und alle Zuege desselben Commits", () => {
    const current = state(1);
    const commitNine: PublicTrain = {
      ...exactTrain,
      operational: { ...exactTrain.operational!, commitSequence: 9, simulationTimeMs: 3_000 },
    };
    expect(applyDelta(current, {
      worldId: "world:1", streamId: "stream:1", sequence: 8, at: 3,
      changed: [commitNine], removed: [],
      changedOperationalRegions: [frame(9, 3_000, 5_000)],
      removedOperationalRegionIds: [],
    })).toBeUndefined();
    expect(applyDelta(current, {
      worldId: "world:1", streamId: "stream:1", sequence: 8, at: 2,
      changed: [], removed: [],
      changedOperationalRegions: [frame(8, 2_000, 4_000)],
      removedOperationalRegionIds: [],
    })).toBeUndefined();
  });

  it("behaelt Regionsframes atomar in Snapshot und Delta", () => {
    const current = initialState(parseSnapshot({
      worldId: "world:1", streamId: "stream-1", sequence: 7, at: 1,
      trains: [exactTrain], operationalRegions: [frame()],
    }));
    const nextTrain: PublicTrain = {
      ...exactTrain,
      positionMm: 1_000,
      mapPosition: { ...exactTrain.mapPosition!, offsetMm: 1_000 },
      operational: {
        ...exactTrain.operational!,
        commitSequence: 8,
        simulationTimeMs: 2_000,
        headRouteMm: 1_000,
        tailRouteMm: -19_000,
      },
    };
    const next = applyDelta(current, parseDelta({
      worldId: "world:1", streamId: "stream-1", sequence: 8, at: 2,
      changed: [nextTrain], removed: [],
      changedOperationalRegions: [{ ...frame(8, 2_000, 4_000), signals: { "signal:1": "shunting-proceed" } }],
      removedOperationalRegionIds: [],
    }));
    expect(next?.operationalRegions.get("region:1")).toMatchObject({
      commitSequence: 8,
      signals: { "signal:1": "shunting-proceed" },
      activeDisruptions: [{
        disruptionId: "disruption:1",
        effect: { "resource-closed": { resourceId: "block:1" } },
      }],
    });
    expect(next?.trains.get("train:1")?.operational?.commitSequence).toBe(8);
  });

  it("akzeptiert operative Zuege ohne erfundene Abweichung oder naechsten Betriebspunkt", () => {
    const {
      delaySeconds: _delaySeconds,
      nextOperatingPoint: _nextOperatingPoint,
      ...withoutLegacyDisplayFields
    } = exactTrain;
    const snapshot = parseSnapshot({
      worldId: "world:1", streamId: "stream-1", sequence: 7, at: 1,
      trains: [withoutLegacyDisplayFields], operationalRegions: [frame()],
    });
    expect(snapshot.trains[0]).not.toHaveProperty("delaySeconds");
    expect(snapshot.trains[0]).not.toHaveProperty("nextOperatingPoint");
  });
});
