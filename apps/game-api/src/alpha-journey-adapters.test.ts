import { describe, expect, it, vi } from "vitest";

import type { StartPackageProof, StartPackageSpec } from "@zugfolge/alpha";

import {
  AuthoritativeOnboardingPort,
  AuthoritativeTutorialResetPort,
  type AlphaJourneyCommandWriter,
} from "./alpha-journey-adapters.js";

const WORLD_ID = "00000000-0000-4000-8000-000000000091";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000092";

const SPEC: StartPackageSpec = {
  schemaVersion: "zugfolge-start-package/v1",
  version: "alpha-2026-08",
  emergencyLotId: "starter-lot-1",
  maximumTrainKmPerPeriod: 1_000,
  vehicleClass: "Mireo",
  maximumVehicleValueCents: 900_000_000n,
  durationS: 21 * 86_400,
  pathWindowId: "starter-path-1",
  personnelPoolId: "starter-pool-1",
  operatingProgramTemplateId: "balanced",
};

const PROOF: StartPackageProof = {
  operatorId: "00000000-0000-4000-8000-000000000093",
  lotId: SPEC.emergencyLotId,
  vehicleId: "starter-vehicle-1",
  vehicleLeaseContractId: "starter-lease-1",
  pathReceiptId: SPEC.pathWindowId,
  personnelPoolId: SPEC.personnelPoolId,
  operatingProgramId: "00000000-0000-4000-8000-000000000094",
  operatingProgramActive: true,
  fleetStateHash: "a".repeat(64),
  economyStateHash: "b".repeat(64),
};

function writer(): AlphaJourneyCommandWriter {
  return {
    resetTutorial: vi.fn(async () => undefined),
    grantStartPackage: vi.fn(async () => PROOF),
    capacityCells: vi.fn(async () => [{
      resourceId: "block-leipzig",
      intervalStartS: 100,
      intervalEndS: 200,
      usedSeconds: 40,
      capacitySeconds: 100,
      qualityClass: "A" as const,
      orderable: true,
    }]),
  };
}

describe("autoritative Alpha-Journey-Adapter", () => {
  it("sendet Tutorial-Resets mit stabiler weltgebundener Kommando-ID an genau einen Writer", async () => {
    const authority = writer();
    const port = new AuthoritativeTutorialResetPort(authority);

    await port.resetAndSeedAccount(WORLD_ID, ACCOUNT_ID, 2);
    await port.resetAndSeedAccount(WORLD_ID, ACCOUNT_ID, 2);

    expect(authority.resetTutorial).toHaveBeenCalledTimes(2);
    expect(authority.resetTutorial).toHaveBeenNthCalledWith(1, {
      schemaVersion: "zugfolge-alpha-tutorial-reset-command/v1",
      commandId: `tutorial-reset:${WORLD_ID}:${ACCOUNT_ID}:2`,
      worldId: WORLD_ID,
      accountId: ACCOUNT_ID,
      resetNumber: 2,
    });
    expect(authority.resetTutorial).toHaveBeenNthCalledWith(2, expect.objectContaining({
      commandId: `tutorial-reset:${WORLD_ID}:${ACCOUNT_ID}:2`,
    }));
  });

  it("reicht Startpaket und Kapazitaet ohne eigenen Schreibzugriff an den Writer durch", async () => {
    const authority = writer();
    const port = new AuthoritativeOnboardingPort(authority);
    const tx = { transactionBoundary: true } as never;

    await expect(port.grantThroughAuthoritativePaths({
      tx,
      worldId: WORLD_ID,
      accountId: ACCOUNT_ID,
      keycloakSubject: "kc-external",
      atS: 123,
      idempotencyKey: `start-package:${WORLD_ID}:${ACCOUNT_ID}:${SPEC.version}`,
      spec: SPEC,
    })).resolves.toEqual(PROOF);
    await expect(port.capacityCells(WORLD_ID, 100, 200)).resolves.toHaveLength(1);

    expect(authority.grantStartPackage).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: "zugfolge-alpha-start-package-command/v1",
      commandId: `start-package:${WORLD_ID}:${ACCOUNT_ID}:${SPEC.version}`,
      tx,
      worldId: WORLD_ID,
      accountId: ACCOUNT_ID,
      keycloakSubject: "kc-external",
      atS: 123,
      spec: SPEC,
    }));
    expect(authority.capacityCells).toHaveBeenCalledWith(WORLD_ID, 100, 200);
  });
});
