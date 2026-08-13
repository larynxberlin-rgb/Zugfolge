import { describe, expect, it } from "vitest";

import { ACTIVITY_POLICY_SCHEMA } from "./activity-policy.js";
import { effectiveActivityPolicy, effectiveStartingCapitalPolicy, validateWorldBlueprint, type AlphaWorldBlueprint } from "./world.js";

const HASH = "a".repeat(64);

function blueprint(overrides: Partial<AlphaWorldBlueprint> = {}): AlphaWorldBlueprint {
  return {
    schemaVersion: "zugfolge-alpha-world-blueprint/v2",
    regionId: "mitteldeutschland-b",
    regionVariant: "B",
    seed: 1n,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: 2,
    releases: { infra: HASH, timetable: HASH, fleet: HASH, economy: HASH },
    lots: [{
      lotId: "lot-1", contractEndsAtPeriod: 1, trainRunIds: ["run-1"], pathReceiptIds: ["path-1"],
      vehicleIds: ["vehicle-1"], personnelDutyIds: ["duty-1"], circulationIds: ["circ-1"], operatingProgramIds: ["program-1"],
    }],
    conflictCheckHash: HASH,
    tenderCalendarHash: HASH,
    startingCapitalPolicy: { mode: "finite", amountCents: "0" },
    entryFacilityPolicy: {
      schemaVersion: "zugfolge-public-entry-facility/v1",
      mode: "award-contingent-wet-lease",
      providerOperatorId: "public",
      costBasis: "formation-operating-cost",
    },
    activityPolicy: null,
    admission: { capacity: 100, status: "open" },
    publicMetadata: {
      description: "Dauerhafte Testwelt", phase: "registration_open", startsAt: "2026-12-13T00:00:00.000Z", endsAt: null,
      regionLabel: "Leipzig–Halle–Erfurt", ruleRelease: "alpha-2026",
      banner: { altText: "Bahnstrecke in Mitteldeutschland", source: "Zugfolge", author: "Zugfolge", license: "Eigenes Werk", attribution: null, focalPointXPermille: 500, focalPointYPermille: 500, rightsApproved: true },
    },
    ...overrides,
  };
}

describe("erweiterte signierte Weltregeln v2", () => {
  it.each([
    { mode: "finite", amountCents: "0" },
    { mode: "finite", amountCents: "25000000" },
    { mode: "unlimited" },
  ] as const)("bindet StartingCapitalPolicy $mode in den Blueprint", (startingCapitalPolicy) => {
    const value = blueprint({ startingCapitalPolicy });
    expect(validateWorldBlueprint(value)).toMatch(/^[a-f0-9]{64}$/);
    expect(effectiveStartingCapitalPolicy(value)).toEqual(
      startingCapitalPolicy.mode === "finite"
        ? { mode: "finite", amountCents: BigInt(startingCapitalPolicy.amountCents) }
        : { mode: "unlimited" },
    );
  });

  it("haelt ActivityPolicy bis zur fachlichen Grenzwertfreigabe unconfigured", () => {
    const value = blueprint({ activityPolicy: null });
    expect(validateWorldBlueprint(value)).toMatch(/^[a-f0-9]{64}$/);
    expect(effectiveActivityPolicy(value)).toBeNull();
  });

  it("akzeptiert eine spaeter freigegebene versionierte ActivityPolicy ohne Loginmetriken", () => {
    const value = blueprint({ activityPolicy: {
      schemaVersion: ACTIVITY_POLICY_SCHEMA, windowSeconds: 604800, minimumScore: 10,
      weights: { "operations.train-outcome": 2, "economy.settlement": 1 },
    } });
    expect(validateWorldBlueprint(value)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("verlangt im öffentlichen Katalogvertrag die explizite Startkapital-Policy", () => {
    expect(() => validateWorldBlueprint(blueprint({ startingCapitalPolicy: undefined }))).toThrow(/Startkapital/);
  });
});
