import { describe, expect, it } from "vitest";

import {
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
  OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  type OperationalSimulationInitialization,
} from "@zugfolge/runtime-native";

import { operationalSimulationInitializationHash } from "./operational-initialization-hash.js";

function initialization(): OperationalSimulationInitialization {
  return {
    schemaVersion: OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
    worldId: "00000000-0000-4000-8000-000000000001",
    regionId: "leipzig-halle-erfurt",
    nowMs: 0,
    repeatEveryMs: null,
    protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
    infraRelease: {
      schemaVersion: "zugfolge-operational-infrastructure/v2",
      releaseId: "infra:2026",
      routes: [{ id: "route:1", edgeIds: ["edge:1"] }],
    },
    vehicleTypes: [{
      vehicleType: { id: "vehicle-type:1", lengthMm: 100_000 },
      powered: true,
    }],
    vehicles: [{ id: "vehicle:1", vehicleTypeId: "vehicle-type:1" }],
    formations: [{ id: "formation:1", predecessorId: null, vehicleIds: ["vehicle:1"] }],
    trains: [{
      id: "train:1",
      trainNumber: "RB 1",
      operatorId: "operator:1",
      movementKind: "train",
      routeVersionId: "route:1",
      formationVersionId: "formation:1",
      headRouteMm: 0,
      scheduledDepartureMs: null,
      publicPassengerStop: true,
      dispatchInterlockingRouteId: "interlocking:1",
      protectionModeSelectionRuns: [{
        throughRouteLegIndex: 0,
        selectedProtectionSystem: "pzb",
      }],
    }],
    movementContinuations: [],
  };
}

describe("OperationalSimulationInitialization-Hash", () => {
  it("ist kanonisch und unabhaengig von Objekt-Schluesselreihenfolgen", () => {
    const first = initialization();
    const reordered = {
      ...first,
      infraRelease: {
        routes: first.infraRelease["routes"],
        releaseId: first.infraRelease["releaseId"],
        schemaVersion: first.infraRelease["schemaVersion"],
      },
    };
    expect(operationalSimulationInitializationHash(reordered)).toBe(
      operationalSimulationInitializationHash(first),
    );
    expect(operationalSimulationInitializationHash(first)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["andere Welt", (value: OperationalSimulationInitialization) => ({ ...value, worldId: `${value.worldId}:fremd` })],
    ["andere Region", (value: OperationalSimulationInitialization) => ({ ...value, regionId: `${value.regionId}:fremd` })],
    ["andere Wiederholung", (value: OperationalSimulationInitialization) => ({ ...value, repeatEveryMs: 86_400_000 })],
    ["anderes InfraRelease", (value: OperationalSimulationInitialization) => ({
      ...value,
      infraRelease: { ...value.infraRelease, releaseId: "infra:2027" },
    })],
    ["andere Formation", (value: OperationalSimulationInitialization) => ({
      ...value,
      formations: [{ ...value.formations[0]!, vehicleIds: ["vehicle:2"] }],
    })],
    ["andere Zugsicherungsmodus-Auswahl", (value: OperationalSimulationInitialization) => ({
      ...value,
      trains: [{
        ...value.trains[0]!,
        protectionModeSelectionRuns: [{
          throughRouteLegIndex: 0,
          selectedProtectionSystem: "lzb" as const,
        }],
      }],
    })],
    ["anderen physischen Fortsetzungsgraphen", (value: OperationalSimulationInitialization) => ({
      ...value,
      repeatEveryMs: 86_400_000,
      movementContinuations: [{
        id: "continuation:1",
        predecessorTrainId: "train:1",
        predecessorBaseRouteVersionId: "route:1",
        successorTrainId: "train:1",
        successorDayOffset: 1 as const,
        dailyBoundary: true,
        minimumDwellMs: 300_000,
        continuity: "reverse-direction" as const,
        successorFormation: "inherit-predecessor" as const,
      }],
    })],
  ] as const)("bindet %s", (_label, change) => {
    const original = initialization();
    expect(operationalSimulationInitializationHash(change(original))).not.toBe(
      operationalSimulationInitializationHash(original),
    );
  });
});
