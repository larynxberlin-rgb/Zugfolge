import { describe, expect, it, vi } from "vitest";
import { assertFareControlPolicy, assertOperationalFareControlCommand, decodeFareControlHoldEvent, FARE_CONTROL_CAUSE, type FareControlPolicyV1 } from "./operational-fare-control.js";
import { operationalSimulationRuntimeFromAddon, type OperationalSimulationNativeAddon } from "./operational-simulation.js";

const policy: FareControlPolicyV1 = {
  schema: "zugfolge-fare-control-policy/v1", policyId: "test-only", revision: 1,
  worldId: "test-world", schedulePeriodId: "test-period", contentHash: "a".repeat(64),
  maxPoliceHoldsPerTrainRun: 1, eligibleReasons: ["identity_refusal", "concrete_danger"],
  targetRule: "next_unreached_scheduled_passenger_stop", providerByStopId: { "test-stop": "test-provider" },
  maxWaitMs: 10_000, policeResponseModelId: "test-model", policeResponseModelHash: "b".repeat(64), publicCause: FARE_CONTROL_CAUSE,
};
describe("Nativer Kontrollhalttransport", () => {
  it("bindet Policy und Commands exakt an Welt, Grund, Revision und Modell", () => {
    expect(() => assertFareControlPolicy(policy, "test-world")).not.toThrow();
    expect(() => assertFareControlPolicy(policy, "other")).toThrow();
    const request = { type: "request-fare-control-hold", request: { trainId: "test-train", caseId: "test-case", reason: "identity_refusal", causalityId: "test-command" } };
    expect(() => assertOperationalFareControlCommand(request)).not.toThrow();
    for (const bad of [
      { ...request, authority: "granted" },
      { ...request, request: { ...request.request, reason: "missing_ticket" } },
      { type: "resolve-fare-control-hold", resolution: { trainId: "t", holdId: "h", modelHash: "b".repeat(64), expectedRevision: 0, outcome: "unavailable", causalityId: "c" } },
      { type: "set-fare-control-policy", policy: { ...policy, worldId: "other" } },
      { type: "cancel-passenger-stop-plan", cancellation: { trainId: "t", expectedStopPlanHash: "short", causalityId: "c" } },
    ]) expect(() => assertOperationalFareControlCommand(bad, "test-world")).toThrow();
  });
  it("verwendet für Policyhashes ausschließlich den nativen Helfer", () => {
    const native = vi.fn(() => "c".repeat(64));
    const runtime = operationalSimulationRuntimeFromAddon({ hashFareControlPolicy: native } as unknown as OperationalSimulationNativeAddon);
    expect(runtime.fareControlPolicyHash!({ ...policy, contentHash: "" })).toBe("c".repeat(64));
    expect(native).toHaveBeenCalledWith(JSON.stringify({ ...policy, contentHash: "" }));
    native.mockReturnValue("not-a-hash");
    expect(() => runtime.fareControlPolicyHash!(policy)).toThrow();
    expect(() => operationalSimulationRuntimeFromAddon({} as OperationalSimulationNativeAddon).fareControlPolicyHash!(policy)).toThrow();
  });
  it("weist private oder fremdgebundene Holdereignisse zurück", () => {
    const event = { schemaVersion: "zugfolge-fare-control-hold-event/v1", worldId: "test-world", trainRunId: "test-train", holdId: "test-hold",
      targetStopId: "test-stop", atMs: 500, status: "active", outcome: null, revision: 2, cause: FARE_CONTROL_CAUSE, causalityId: "test-cause" };
    expect(decodeFareControlHoldEvent(event, "test-world", "test-train", 500)).toEqual(event);
    for (const bad of [{ ...event, caseIds: ["private"] }, { ...event, fareFact: "private" }, { ...event, worldId: "other" }, { ...event, atMs: 501 }, { ...event, outcome: "identity_confirmed" }]) {
      expect(() => decodeFareControlHoldEvent(bad, "test-world", "test-train", 500)).toThrow();
    }
  });
});
