import { describe, expect, it } from "vitest";
import { decodeOperationalDailyRestrictions, OPERATIONAL_DAILY_RESTRICTIONS_SCHEMA, OPERATIONAL_DAILY_RESTRICTIONS_GENERATED_SCHEMA, type OperationalDailyRestrictionsRequest } from "./operational-daily-restrictions.js";

const request: OperationalDailyRestrictionsRequest = {
  schemaVersion: OPERATIONAL_DAILY_RESTRICTIONS_SCHEMA,
  worldId: "world-a", regionId: "region-a", seed: "77", dayStartMs: 0,
  infraRelease: { schemaVersion: "zugfolge-operational-infrastructure-binding/v2", infraReleaseId: "infra-a", file: "operational-infrastructure-v2.json", bytes: 10, sha256: "a".repeat(64), stateHash: "b".repeat(64) },
  routeVersionIds: ["route-a"],
  policy: { version: 1, plannedWorksMode: "SIMULATED", operationalIncidentMode: "SIMULATED", providerSetId: null, simulationProfile: { id: "test" }, rulesetVersion: "rules/v1", validFromMs: 0, validUntilMs: null },
};
function result() {
  return {
    schemaVersion: OPERATIONAL_DAILY_RESTRICTIONS_GENERATED_SCHEMA,
    worldId: "world-a", regionId: "region-a", dayStartMs: 0, policyVersion: 1,
    restrictions: [{ disruptionId: "daily-a", startsAtMs: 0, endsAtMs: 10_000, effect: { "speed-restriction": { edgeId: "edge-a", maximumSpeedMmps: 5_555 } }, provenance: { kind: "simulated-daily-restriction" } }],
    unsupportedRestrictions: [{ effect: { type: "closure" }, scope: { traffic: "passenger" }, reason: "operational-effect-not-supported" }],
  };
}

describe("native La-Transportgrenze", () => {
  it("bewahrt die native Wirkung und die ausdruecklich nicht aktivierbare Diagnose", () => {
    expect(decodeOperationalDailyRestrictions(JSON.stringify(result()), request)).toEqual(result());
  });
  it.each(["worldId", "regionId", "dayStartMs", "policyVersion", "schemaVersion"])("verweigert einen fremden %s-Beleg", (field) => {
    expect(() => decodeOperationalDailyRestrictions(JSON.stringify({ ...result(), [field]: "foreign" }), request)).toThrow(/bindung/u);
  });
  it("verweigert doppelte IDs, nicht begrenzte Laufzeit und umgedeutete Wirkungen", () => {
    const duplicate = result(); duplicate.restrictions.push(duplicate.restrictions[0]!);
    const tooLong = result(); tooLong.restrictions[0]!.endsAtMs = 172_800_001;
    const invalidSpeed = result(); invalidSpeed.restrictions[0]!.effect["speed-restriction"].maximumSpeedMmps = 0;
    for (const value of [duplicate, tooLong, invalidSpeed]) expect(() => decodeOperationalDailyRestrictions(JSON.stringify(value), request)).toThrow();
    const changedEffect = { ...result(), restrictions: [{ ...result().restrictions[0], effect: { "resource-closed": { resourceId: "edge-a" } } }] };
    expect(() => decodeOperationalDailyRestrictions(JSON.stringify(changedEffect), request)).toThrow(/Wirkung/u);
  });
});
