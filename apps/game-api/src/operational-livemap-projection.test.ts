import { describe, expect, it } from "vitest";

import type { OperationalProjection } from "@zugfolge/runtime-native";

import { projectOperationalLivemap } from "./operational-livemap-projection.js";

function projection(): OperationalProjection {
  return {
    kind: "live-map",
    worldId: "world:1",
    regionId: "region:1",
    infraReleaseId: "infra:v2",
    commitSequence: 42,
    atMs: 10_000,
    staleAfterMs: 15_000,
    trains: [{
      trainId: "train:1",
      trainNumber: "RE 1",
      operatorId: "operator:1",
      movementKind: "train",
      motionState: "moving",
      direction: "along",
      routeVersionId: "route:v2",
      formationVersionId: "formation:v2",
      headRouteMm: 10_000,
      tailRouteMm: 8_000,
      speedMmps: 20_000,
      occupiedIntervals: [{ edgeId: "edge:1", fromMm: 8_000, toMm: 10_000, direction: "along" }],
      occupiedBlocks: ["block:1"],
      authorityEndRouteMm: 25_000,
      motionSegment: {
        startedAtMs: 10_000,
        validUntilMs: 30_000,
        startRouteMm: 10_000,
        startSpeedMmps: 20_000,
        accelerationMmps2: 500,
        routeVersionId: "route:v2",
        authorityEndRouteMm: 25_000,
        segmentEndRouteMm: 20_000,
      },
      headGeometry: {
        routeMm: 10_000,
        edgeId: "edge:1",
        edgeOffsetMm: 10_000,
        latitudeE7: 510_000_000,
        longitudeE7: 120_000_000,
        bearingMilliDegrees: 90_000,
      },
      tailGeometry: {
        routeMm: 8_000,
        edgeId: "edge:1",
        edgeOffsetMm: 8_000,
        latitudeE7: 509_999_800,
        longitudeE7: 119_999_800,
        bearingMilliDegrees: 90_000,
      },
      motionGeometry: [{
        routeMm: 10_000,
        edgeId: "edge:1",
        edgeOffsetMm: 10_000,
        latitudeE7: 510_000_000,
        longitudeE7: 120_000_000,
        bearingMilliDegrees: 90_000,
      }, {
        routeMm: 20_000,
        edgeId: "edge:1",
        edgeOffsetMm: 20_000,
        latitudeE7: 510_001_000,
        longitudeE7: 120_001_000,
        bearingMilliDegrees: 90_000,
      }],
      waitingReason: null,
    }],
    routeLocks: [{
      id: "lock:1",
      templateId: "route-lock:1",
      trainId: "train:1",
      resources: ["block:1", "flank:1"],
      releaseAfterTailRouteMm: 18_000,
      lockedAtMs: 9_000,
    }],
    signals: { "signal:1": "proceed" },
    activeDisruptions: [{
      disruptionId: "disruption:1",
      effect: { "resource-closed": { resourceId: "block:1" } },
    }],
  };
}

describe("operative LiveMap-Allowlist", () => {
  it("bindet Zug, Fahrstrasse und Signale an denselben Regionscommit", () => {
    const projected = projectOperationalLivemap(projection());
    expect(projected.at).toBe(10);
    expect(projected.operationalRegions).toEqual([expect.objectContaining({
      regionId: "region:1",
      infrastructureReleaseId: "infra:v2",
      commitSequence: 42,
      simulationTimeMs: 10_000,
      staleAfterMs: 15_000,
      signals: { "signal:1": "proceed" },
      activeDisruptions: [{
        disruptionId: "disruption:1",
        effect: { "resource-closed": { resourceId: "block:1" } },
      }],
    })]);
    expect(projected.trains).toEqual([expect.objectContaining({
      id: "train:1",
      operatorId: "operator:1",
      operator: "operator:1",
      category: "train",
      positionMm: 10_000,
      status: "running",
      operational: expect.objectContaining({
        regionId: "region:1",
        commitSequence: 42,
        simulationTimeMs: 10_000,
        occupiedBlocks: ["block:1"],
        motionSegment: expect.objectContaining({
          validUntilMs: 15_000,
          startSpeedMmPerSecond: 20_000,
          accelerationMmPerSecondSquared: 500,
        }),
      }),
      mapPosition: expect.objectContaining({
        infrastructureReleaseId: "infra:v2",
        trackId: "edge:1",
        offsetMm: 10_000,
      }),
    })]);
    expect(projected.trains[0]).not.toHaveProperty("delaySeconds");
    expect(projected.trains[0]).not.toHaveProperty("nextOperatingPoint");
  });

  it("liefert auch im Stillstand ausschliesslich den exakten Rust-Kopfpunkt", () => {
    const source = projection();
    const standing: OperationalProjection = {
      ...source,
      trains: [{
        ...source.trains[0]!,
        motionState: "safe-stop",
        speedMmps: 0,
        motionSegment: null,
        motionGeometry: [],
        waitingReason: "Signalstoerung",
      }],
    };
    const train = projectOperationalLivemap(standing).trains[0]!;
    expect(train.status).toBe("waiting");
    expect(train.mapPosition).toMatchObject({ trackId: "edge:1", offsetMm: 10_000 });
    expect(train.operational?.motionSegment).toBeUndefined();
  });

  it("publiziert den zeitlichen Bremsrest mit genau seiner tatsächlichen Position", () => {
    const source = projection();
    const train = source.trains[0]!;
    const constant = { ...train, motionGeometry: [train.headGeometry], motionSegment: {
      ...train.motionSegment!, segmentEndRouteMm: train.headRouteMm, validUntilMs: 10_001,
      startSpeedMmps: 70, accelerationMmps2: -900,
    } };
    const projected = projectOperationalLivemap({ ...source, trains: [constant] }).trains[0]!;
    expect(projected.operational?.motionSegment?.geometry).toHaveLength(1);
    expect(projected.mapPosition).toMatchObject({ trackId: "edge:1", offsetMm: 10_000 });
    expect(() => projectOperationalLivemap({ ...source, trains: [{ ...constant, motionGeometry: [] }] }))
      .toThrow(/Bewegungsverlauf/);
  });

  it("verwirft eine getrennte RZUE-Projektion und unvollstaendige Bewegungsgeometrie", () => {
    expect(() => projectOperationalLivemap({ ...projection(), kind: "rzue" })).toThrow(/LiveMap-Projektion/);
    const source = projection();
    expect(() => projectOperationalLivemap({
      ...source,
      trains: [{ ...source.trains[0]!, motionGeometry: [] }],
    })).toThrow(/Bewegungsverlauf/);
    expect(() => projectOperationalLivemap({
      ...source,
      trains: [{ ...source.trains[0]!, motionSegment: null, motionGeometry: [] }],
    })).toThrow(/Bewegungszustand/);
  });
});
