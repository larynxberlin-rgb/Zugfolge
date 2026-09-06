import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { ConductorTrainStateV1 } from "@zugfolge/runtime-native";
import { parseConductorControlDeployment } from "./conductor-control-configuration.js";
import { createConductorControlIntegration } from "./conductor-control.js";
import { fareControlRuntimeFromAddon, type ConductorPoliceAdapter, type FareControlRuntime, type FareControlState } from "./conductor-control-runtime.js";
import type { ConductorCommittedContext } from "./conductor-context.js";

it("hält private Parser- und Datenbankdetails hinter einer festen Fehlergrenze", async () => {
  const marker = "private-control-source-marker";
  const runtime = fareControlRuntimeFromAddon({ initializeFareControl() { throw new Error(marker); } });
  expect(() => runtime.initialize("world", "operator", 0)).toThrow("fare_control_core_rejected");
  const control = createConductorControlIntegration({ runtime, releases: { resolve() { throw new Error(marker); } }, police: {} as ConductorPoliceAdapter });
  const context = { projectionInput: { binding: { worldId: "world", operatorId: "operator", trainRunId: "train" } } } as ConductorCommittedContext;
  const train = { worldId: "world", trainRunId: "train", session: { operatorId: "operator" } } as ConductorTrainStateV1;
  const db = { select() { throw new Error(marker); } } as unknown as IdentityDatabase;
  await expect(control.evidence(db, context, train)).rejects.toMatchObject({ code: "conductor_control_unavailable" });
  await expect(control.evidence(db, context, train)).rejects.not.toThrow(marker);
});
it("weist falsche Deploymentpins, fremde Welten, unsichere Zahlen und übergroße Listen vor jedem Kernaufruf ab", () => {
  const policyHash = vi.fn(), runtime = { policyHash } as unknown as FareControlRuntime;
  const attempts = [
    { schemaVersion: "conductor-control-deployment/v1", worldId: "foreign", periods: [] },
    { schemaVersion: "conductor-control-deployment/v1", worldId: "world", periods: [], injectedPolicy: {} },
    { schemaVersion: "conductor-control-deployment/v1", worldId: "world", periods: new Array(257).fill({}) },
    { schemaVersion: "conductor-control-deployment/v1", worldId: "world", periods: [{ validFromMs: Number.MAX_SAFE_INTEGER + 1 }] },
  ];
  for (const body of attempts) {
    const bytes = Buffer.from(JSON.stringify(body)), expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    expect(() => parseConductorControlDeployment({ bytes, expectedSha256, worldId: "world", runtime })).toThrow("conductor_control_configuration_invalid");
  }
  expect(() => parseConductorControlDeployment({ bytes: Buffer.from("private-json-marker"), expectedSha256: "a".repeat(64), worldId: "world", runtime })).toThrow("conductor_control_configuration_invalid");
  expect(policyHash).not.toHaveBeenCalled();
});
it("lässt zusätzliche private Felder niemals durch die öffentliche Fallprojektion", () => {
  const runtime = fareControlRuntimeFromAddon({ projectFareCases() { return JSON.stringify([{ caseId: "case", encounterId: "encounter", trainRunId: "train",
    status: "open", evidence: {}, claimKind: null, claimCents: "0", paidCents: "0", costsCents: "0", writtenOffCents: "0", proofDeadlineMs: 0,
    fareFact: "private-marker" }]); } });
  expect(() => runtime.project({ worldId: "world", operatorId: "operator", stateHash: "a".repeat(64) } as FareControlState)).toThrow("fare_control_core_rejected");
});
