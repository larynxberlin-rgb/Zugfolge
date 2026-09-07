import { expect, it } from "vitest";
import { createConductorSessionNativeFixture, hasSessionNativeFixture } from "./conductor-session.native-fixture.js";
import { DemandStore } from "./demand-store.js";
import type { FareControlHoldV1, FareControlPolicyV1, OperationalSimulationCommandPayload } from "@zugfolge/runtime-native";

const nativeIt = hasSessionNativeFixture ? it : it.skip;
nativeIt("führt drei Compilerformationen über tatsächliche Kontrollhaltfolge, Kreuzung, Rangieren, Restore und M10-Neuwahl", async () => {
  const fixture = await createConductorSessionNativeFixture({ async evidence() { return { encounterEvidence: [], controlReceipts: [] }; },
    async apply(_tx, _context, _state, effects) { if (effects.length) throw new Error("Dieser Quellbeleg führt keine Dialogeffekte aus."); } }, {
    networkScenario: "conductor-network-acceptance/v1", demandSeed: "138",
    oneServiceContract: { lotId: "explicit-network-one-service", serviceDay: "1970-01-01", requiredSeats: 120, terminalArrivalMs: 3_000_000 },
  });
  try {
    expect(fixture.initialization.trains.map((train) => train.id)).toEqual(["regional-1", "regional-follow", "network-empty", "network-shunt"]);
    expect(fixture.network.evidence.actualCompilerVehicleIds).toEqual(["fixture-interior-vehicle-1", "fixture-interior-vehicle-3", "fixture-interior-vehicle-2"]);
    const store = new DemandStore(fixture.db, fixture.native.demand);
    const initial = (await store.latest(fixture.access.worldId))!;
    expect(initial.result["projectionMode"]).toBe("progress_bound");
    const services = initial.input["services"] as { trainRunId: string; capacity: Record<string, number> }[];
    expect(services.map((service) => service.trainRunId).sort()).toEqual(["network-later", "network-onward", "regional-1", "regional-follow"]);
    expect(services.find((service) => service.trainRunId === "regional-follow")!.capacity).toMatchObject({ standardSeats: 80, premiumSeats: 16, standardStanding: 48 });
    let serial = 0;
    const command = async (payload: OperationalSimulationCommandPayload) => {
      const result = await fixture.apply(`network-integration:${++serial}`, payload); await fixture.refresh(); return result;
    };
    const advanceTo = async (atMs: number) => { fixture.clock.nowMs = atMs; return command({ type: "advance-to", atMs }); };
    const policy: FareControlPolicyV1 = { schema: "zugfolge-fare-control-policy/v1", policyId: "explicit-network-duration", revision: 1,
      worldId: fixture.access.worldId, schedulePeriodId: "explicit-network-period", contentHash: "", maxPoliceHoldsPerTrainRun: 1,
      eligibleReasons: ["identity_refusal", "concrete_danger"], targetRule: "next_unreached_scheduled_passenger_stop",
      providerByStopId: Object.fromEntries(fixture.initialization.trains[0]!.stopPlan!.stops.map((stop) => [stop.stopId, "explicit-test-police"])),
      maxWaitMs: 3_600_000, policeResponseModelId: "explicit-test-duration", policeResponseModelHash: "a".repeat(64), publicCause: "authority.police.fare-control" };
    await command({ type: "set-fare-control-policy", policy: { ...policy, contentHash: fixture.native.operational.fareControlPolicyHash!(policy) } });
    await command({ type: "request-fare-control-hold", request: { trainId: fixture.access.trainRunId,
      caseId: "explicit-test-authorized-case", reason: "identity_refusal", causalityId: "explicit-test-network" } });
    const active = await advanceTo(1_920_001);
    const hold = (active.state.world["fareControlState"] as { holds: Record<string, FareControlHoldV1> }).holds[fixture.access.trainRunId]!;
    expect(hold.status).toBe("active");
    const { createConductorNetworkProofDriver } = await import(new URL("../../../tools/conductor-session/network-driver.mjs", import.meta.url).href);
    const driver = createConductorNetworkProofDriver({ fixture, command, advanceTo });
    const fork = await driver.startAtActiveHold();
    await advanceTo(hold.activatedAtMs! + 3_540_000);
    await command({ type: "resolve-fare-control-hold", resolution: { trainId: fixture.access.trainRunId, holdId: hold.holdId,
      expectedRevision: hold.revision, modelHash: hold.modelHash, outcome: "identity_confirmed", causalityId: "explicit-test-duration-completed" } });
    const finished = await driver.finishAfterRelease();
    expect(finished.leaderDelayMs).toBeGreaterThan(0); expect(finished.followerDelayMs).toBeGreaterThan(0);
    expect(finished.demand.replannedPassengers).toBeGreaterThan(0);
    expect(finished.resourceWaits.map((wait: { trainRunId: string }) => wait.trainRunId)).toEqual(["regional-follow", "network-empty"]);
    for (const wait of finished.resourceWaits) {
      expect(wait.blockedByTrainRunId).toBe(fixture.access.trainRunId);
      expect(wait.occupiedByLeader || wait.leaderRouteLockIds.length > 0).toBe(true);
    }
    expect(fork.baseline.finalStateHash).toBe(fork.baseline.replayStateHash);
    console.log(JSON.stringify({ leaderDelayMs: finished.leaderDelayMs, followerDelayMs: finished.followerDelayMs,
      replannedPassengers: finished.demand.replannedPassengers, resourceWaits: finished.resourceWaits, shuntingEnd: finished.actualCompleted["network-shunt"],
      actualStateHash: finished.actualStateHash, baselineStateHash: finished.baselineStateHash }));
  } finally { await fixture.dispose(); }
}, 600_000);
