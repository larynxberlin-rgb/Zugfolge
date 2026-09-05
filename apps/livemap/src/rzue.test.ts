import { describe, expect, it } from "vitest";

import type { PublicOperationalRegionFrame } from "@zugfolge/livemap-stream";

import type { PublicTrain } from "./protocol.js";
import { rzueMarkup } from "./rzue.js";

const train: PublicTrain = {
  id: "train:1",
  operator: "EVU",
  trainNumber: "RB 1",
  category: "regional",
  positionMm: 40_000,
  speedMmPerSecond: 10_000,
  delaySeconds: 0,
  nextOperatingPoint: "Leipzig Hbf",
  status: "running",
  operational: {
    regionId: "region:1",
    commitSequence: 42,
    simulationTimeMs: 100_000,
    routeVersionId: "route:v1",
    formationVersionId: "formation:v1",
    movementKind: "train",
    headRouteMm: 40_000,
    tailRouteMm: 20_000,
    direction: "along",
    occupiedIntervals: [{ trackId: "track:1", fromMm: 20_000, toMm: 40_000, direction: "along" }],
    occupiedBlocks: ["block:1"],
    authorityEndRouteMm: 80_000,
    waitingReason: "Gegenfahrt",
  },
};

const frame: PublicOperationalRegionFrame = {
  regionId: "region:1",
  infrastructureReleaseId: "infra:v2",
  commitSequence: 42,
  simulationTimeMs: 100_000,
  staleAfterMs: 175_000,
  routeLocks: [{
    id: "lock:1",
    templateId: "route-lock:1",
    trainId: "train:1",
    resources: ["block:1", "flank:1"],
    releaseAfterTailRouteMm: 80_000,
    lockedAtMs: 99_000,
  }],
  signals: { "signal:1": "proceed", "signal:2": "failed" },
  activeDisruptions: [{
    disruptionId: "disruption:1",
    effect: { "signal-failed": { signalId: "signal:2" } },
  }],
};

describe("RZÜ-Projektion", () => {
  it("zeigt denselben Commit sowie Spitze, Schluss, Fahrberechtigung und Wartegrund", () => {
    const markup = rzueMarkup([train], [frame], true);
    expect(markup).toContain("COMMIT 42");
    expect(markup).toContain("rzue-head");
    expect(markup).toContain("rzue-tail");
    expect(markup).toContain("rzue-authority");
    expect(markup).toContain("Gegenfahrt");
    expect(markup).toContain("block:1");
    expect(markup).toContain("lock:1");
    expect(markup).toContain("flank:1");
    expect(markup).toContain("signal:1");
    expect(markup).toContain("signal:2");
    expect(markup).toContain("failed");
    expect(markup).toContain("disruption:1");
    expect(markup).toContain("signal-failed");
  });

  it("schätzt ohne exakten Zustand keine Lage", () => {
    expect(rzueMarkup([{ ...train, operational: undefined }], [frame], false)).toContain("wartet auf aktuelle Betriebsdaten");
    expect(rzueMarkup([train], [], false)).toContain("KEIN REGIONSFRAME");
  });

  it("zeigt keinen Zug unter einem fremden Regionscommit", () => {
    expect(rzueMarkup([train], [{ ...frame, commitSequence: 43 }], false))
      .toContain("wartet auf aktuelle Betriebsdaten");
  });
});
