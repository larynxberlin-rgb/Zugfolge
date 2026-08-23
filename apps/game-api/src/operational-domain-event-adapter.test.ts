import type {
  OperationalProjection,
  OperationalSimulationState,
} from "@zugfolge/runtime-native";
import { describe, expect, it } from "vitest";

import {
  adaptOperationalDomainEvents,
  type OperationalCommitEventContext,
  type OperationalNativeEvent,
} from "./operational-domain-event-adapter.js";

const WORLD_ID = "11111111-1111-4111-8111-111111111111";

function state(activeDisruptions: Readonly<Record<string, unknown>> = {}): OperationalSimulationState {
  return {
    schemaVersion: "zugfolge-operational-simulation-state/v2",
    world: {
      worldId: WORLD_ID,
      regionId: "leipzig",
      infraReleaseId: "infra:v2",
      nowMs: 1_000,
      commitSequence: 4,
      eventSequence: 10,
      activeDisruptions,
    },
    revision: 4,
    publisherSequence: 4,
    stateHash: "a".repeat(64),
  };
}

function projection(): OperationalProjection {
  const train = {
    trainId: "train:1",
    trainNumber: "RE 1",
    operatorId: "operator:1",
    movementKind: "train" as const,
    motionState: "safe-stop" as const,
    direction: "along" as const,
    routeVersionId: "route:1",
    formationVersionId: "formation:1",
    headRouteMm: 100,
    tailRouteMm: 0,
    speedMmps: 0,
    occupiedIntervals: [],
    occupiedBlocks: ["block:1"],
    authorityEndRouteMm: 100,
    motionSegment: null,
    headGeometry: {
      routeMm: 100,
      edgeId: "edge:1",
      edgeOffsetMm: 100,
      latitudeE7: 510_000_000,
      longitudeE7: 120_000_000,
      bearingMilliDegrees: null,
    },
    tailGeometry: null,
    motionGeometry: [],
    waitingReason: "infrastructure-disruption",
  };
  return {
    kind: "live-map",
    worldId: WORLD_ID,
    regionId: "leipzig",
    infraReleaseId: "infra:v2",
    commitSequence: 5,
    atMs: 1_000,
    staleAfterMs: 76_000,
    trains: [train],
    routeLocks: [],
    signals: {},
    activeDisruptions: [],
  };
}

function event(kind: string, subjectId: string, detail: string): OperationalNativeEvent {
  return {
    eventSequence: kind === "train-safe-stopped" ? 11 : 12,
    commitSequence: 5,
    atMs: 1_000,
    kind,
    subjectId,
    detail,
  };
}

describe("operativer Domain-Event-Adapter", () => {
  it("bindet eine Aktivierung exakt an Wirkung, betroffene Fahrt und alle expliziten EVUs", () => {
    const context: OperationalCommitEventContext = {
      commitSequence: 5,
      command: {
        type: "activate-disruption",
        disruptionId: "disruption:1",
        effect: { "resource-closed": { resourceId: "block:1" } },
      },
      stateBefore: state(),
      projectionAfter: projection(),
    };
    const adapted = adaptOperationalDomainEvents([
      event("train-safe-stopped", "train:1", "infrastructure-disruption"),
      event("disruption-activated", "disruption:1", "concrete-resource-or-vehicle"),
    ], [context], ["operator:2", "operator:1", "operator:1"], "leipzig");

    expect(adapted[0]).toMatchObject({
      eventType: "operational.train-safe-stopped",
      payload: { nativeEventSequence: 11, commitSequence: 5 },
    });
    expect(adapted[1]).toEqual({
      eventType: "disruption.applied",
      payload: {
        schemaVersion: "zugfolge-operational-disruption-event/v2",
        nativeEventSequence: 12,
        regionId: "leipzig",
        commitSequence: 5,
        simulationTimeMs: 1_000,
        subjectId: "disruption:1",
        detail: "concrete-resource-or-vehicle",
        disruptionId: "disruption:1",
        action: "apply_disruption",
        cause: "concrete-resource-or-vehicle",
        effect: "closure",
        operationalEffect: { "resource-closed": { resourceId: "block:1" } },
        affectedResource: "block:1",
        affectedTrainRunIds: ["train:1"],
        trainRunIds: ["train:1"],
        operatorIds: ["operator:1", "operator:2"],
        impact: { affectedResource: "block:1", affectedTrainRuns: 1 },
      },
    });
  });

  it("bindet eine Freigabe an die vorher aktive Wirkung und die technische Referenz", () => {
    const effect = { "signal-failed": { signalId: "signal:1" } };
    const context: OperationalCommitEventContext = {
      commitSequence: 5,
      command: {
        type: "clear-disruption",
        disruptionId: "disruption:1",
        releaseReference: "repair-order:42",
      },
      stateBefore: state({ "disruption:1": effect }),
      projectionAfter: projection(),
    };
    const [adapted] = adaptOperationalDomainEvents([
      event("disruption-cleared", "disruption:1", "repair-order:42"),
    ], [context], ["operator:1"], "leipzig");

    expect(adapted).toMatchObject({
      eventType: "disruption.cleared",
      payload: {
        action: "clear_disruption",
        operationalEffect: effect,
        effect: "signal-failure",
        affectedResource: "signal:1",
        releaseReference: "repair-order:42",
      },
    });
  });

  it("weist einen fehlenden oder abweichenden Kommandokontext geschlossen zurueck", () => {
    expect(() => adaptOperationalDomainEvents([
      event("disruption-activated", "disruption:1", "concrete-resource-or-vehicle"),
    ], [], [], "leipzig")).toThrow(/keinen gebundenen Kommandokontext/);

    expect(() => adaptOperationalDomainEvents([
      event("disruption-cleared", "disruption:1", "repair-order:42"),
    ], [{
      commitSequence: 5,
      command: {
        type: "clear-disruption",
        disruptionId: "disruption:1",
        releaseReference: "foreign-release",
      },
      stateBefore: state({
        "disruption:1": { "resource-closed": { resourceId: "block:1" } },
      }),
      projectionAfter: projection(),
    }], [], "leipzig")).toThrow(/Freigabekommando/);
  });
});
