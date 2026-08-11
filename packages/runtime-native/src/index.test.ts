import { describe, expect, it } from "vitest";

import {
  OPERATING_INITIALIZE_SCHEMA,
  OPERATING_TRANSITION_SCHEMA,
  operatingRuntimeFromAddon,
} from "./index.js";

const worldId = "11111111-1111-4111-8111-111111111111";

describe("native runtime ABI contract", () => {
  it("rejects a cross-world native result instead of trusting the addon", () => {
    const runtime = operatingRuntimeFromAddon({
      verifyFleetMobilizationSnapshot: () => JSON.stringify({
        schemaVersion: "zugfolge-fleet-mobilization-verification/v1",
        worldId,
        fleetRevision: 1,
        snapshotHash: "c".repeat(64),
      }),
      initializeOperatingWorld: () => JSON.stringify({
        schemaVersion: "zugfolge-operating-world-initialized/v1",
        state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId, revision: 0 },
        stateHash: "a".repeat(64),
      }),
      applyOperatingTransition: () => JSON.stringify({
        schemaVersion: "zugfolge-operating-transition-result/v1",
        state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId: "other", revision: 1 },
        stateHash: "b".repeat(64),
        outcome: { lotId: "lot", previousOperatorId: "old", operatorId: "new", kind: "operator-change", seamless: false, penaltyRequired: false, trainRunIds: ["train"], livemapMarker: null },
        events: [],
        idempotentReplay: false,
      }),
    });
    const initialized = runtime.initialize({
      schemaVersion: OPERATING_INITIALIZE_SCHEMA,
      worldId,
      lots: [{ lotId: "lot", incumbentOperatorId: "old", timetableBoundaryS: 10, trainRuns: [{ trainRunId: "train", formationId: "old-1" }] }],
    });
    expect(() => runtime.applyTransition(initialized.state, {
      schemaVersion: OPERATING_TRANSITION_SCHEMA,
      worldId,
      commandId: "transition",
      expectedStateHash: initialized.stateHash,
      expectedRevision: 0,
      lotId: "lot",
      atS: 10,
      winnerOperatorId: "new",
      mobilizationProof: null,
      publicVehiclePool: ["public-1"],
    })).toThrow(/Weltisolation/);
  });

  it("rejects malformed hashes at the ABI boundary", () => {
    const runtime = operatingRuntimeFromAddon({
      verifyFleetMobilizationSnapshot: () => JSON.stringify({
        schemaVersion: "zugfolge-fleet-mobilization-verification/v1",
        worldId,
        fleetRevision: 1,
        snapshotHash: "c".repeat(64),
      }),
      initializeOperatingWorld: () => JSON.stringify({
        schemaVersion: "zugfolge-operating-world-initialized/v1",
        state: { schemaVersion: "zugfolge-operating-world-state/v1", worldId, revision: 0 },
        stateHash: "not-a-hash",
      }),
      applyOperatingTransition: () => "{}",
    });
    expect(() => runtime.initialize({ schemaVersion: OPERATING_INITIALIZE_SCHEMA, worldId, lots: [] })).toThrow(/SHA-256/);
  });

  it("binds native M5 verification to the supplied world and revision", () => {
    const runtime = operatingRuntimeFromAddon({
      verifyFleetMobilizationSnapshot: () => JSON.stringify({
        schemaVersion: "zugfolge-fleet-mobilization-verification/v1",
        worldId: "other",
        fleetRevision: 7,
        snapshotHash: "c".repeat(64),
      }),
      initializeOperatingWorld: () => "{}",
      applyOperatingTransition: () => "{}",
    });
    expect(() => runtime.verifyFleetMobilizationSnapshot({ worldId, revision: 7 })).toThrow(/Weltisolation/);
  });
});
