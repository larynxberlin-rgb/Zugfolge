import { describe, expect, it } from "vitest";

import { PUBLIC_WORLD_SNAPSHOT_VERSION, validatePublicWorldSnapshot, type PublicWorldSnapshotV1 } from "./public-world-snapshot.js";

function snapshot(overrides: Partial<PublicWorldSnapshotV1> = {}): PublicWorldSnapshotV1 {
  return {
    projectionVersion: PUBLIC_WORLD_SNAPSHOT_VERSION, worldId: "11111111-1111-4111-8111-111111111111", worldName: "LHE",
    shortDescription: "Test", phase: "active", startsAt: "2026-01-01T00:00:00Z", endsAt: null,
    authoritativeAsOf: "2026-01-02T00:00:00Z", remainingRuntimeSeconds: null,
    startingCapitalPolicy: { mode: "finite", amountCents: "0" }, totalOperators: 2, stronglyActiveOperators: null,
    activityPolicyStatus: "unconfigured", activityExplanation: "Grenzwerte noch nicht freigegeben.",
    capacity: 10, freePlaces: 8, admissionStatus: "open", region: "LHE", ruleRelease: "r1",
    releases: { infra: "a".repeat(64), timetable: "b".repeat(64), fleet: "c".repeat(64), economy: "d".repeat(64) },
    banner: { altText: "Strecke", source: "Zugfolge", author: "Zugfolge", license: "Eigenes Werk", attribution: null, focalPointXPermille: 500, focalPointYPermille: 500, rightsApproved: true },
    generatedAt: "2026-01-02T00:00:10Z", ...overrides,
  };
}

describe("PublicWorldSnapshot", () => {
  it("akzeptiert ausschliesslich aggregierte Werte", () => expect(() => validatePublicWorldSnapshot(snapshot())).not.toThrow());
  it("verhindert eine Aktivitaetszahl ohne freigegebene Policy", () => {
    expect(() => validatePublicWorldSnapshot(snapshot({ stronglyActiveOperators: 1 }))).toThrow(/ActivityPolicy/);
  });
  it("verhindert verschachtelten Personenbezug", () => {
    const unsafe = { ...snapshot(), banner: { ...snapshot().banner, playerId: "p-1" } } as unknown as PublicWorldSnapshotV1;
    expect(() => validatePublicWorldSnapshot(unsafe)).toThrow(/Personenbezug/);
  });
});
