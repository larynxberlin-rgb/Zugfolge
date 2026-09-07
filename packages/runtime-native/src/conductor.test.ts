import { describe, expect, it } from "vitest";
import { conductorProjectionRuntimeFromAddon, loadConductorProjectionRuntime, type ProjectConductorPassengersInputV1 } from "./conductor.js";

// Reine ABI-Fixture: fachliche Belegung beweisen die Rust- und nativen Integrationstests.
const pin = "a".repeat(64);
const input: ProjectConductorPassengersInputV1 = {
  schemaVersion: "conductor-passenger-projection-input/v1",
  binding: { worldId: "world", periodId: "period", demandReleaseId: "demand", releaseHash: pin, seedHash: pin,
    trainRunId: "train", operatorId: "owner", manifestRevision: 2, demandStateHash: pin, operationalReceiptId: "receipt" },
  evaluation: { nowMs: 1000 }, service: {},
  interior: { schemaVersion: "interior-passenger-places/v1", worldId: "world", trainRunId: "train", layoutId: "layout", layoutHash: pin,
    places: [{ placeId: "place", vehicleId: "vehicle", xMm: 100, yMm: 200, comfortClass: "standard", kind: "seat", spaceNeeds: ["ordinary"] }] },
};
const output = () => ({ schemaVersion: "passenger-projection/v1", binding: { ...input.binding }, segmentId: "segment", fromStopId: "a", toStopId: "b",
  layoutId: "layout", layoutHash: pin, asOfMs: 1000, phase: "in_transit", currentStopId: null,
  passengers: [{ passengerKey: "passenger", placeId: "place", vehicleId: "vehicle", xMm: 100, yMm: 200,
    comfortClass: "standard", spaceNeeds: "ordinary", posture: "seated", appearanceVariant: 3, activity: "onboard" }], stateHash: pin });

describe("M15-Projektion: private ABI-Grenze", () => {
  it("überträgt die belegte Eingabe vollständig und übernimmt nur sichtbare Felder", () => {
    const runtime = conductorProjectionRuntimeFromAddon({ projectConductorPassengers(json) {
      expect(JSON.parse(json)).toEqual(input); return JSON.stringify(output());
    } });
    expect(runtime.project(input)).toEqual(output());
  });

  it.each(["fareFact", "journeyChainId", "reservationId", "demandSegment"])("verweigert versehentlich offengelegte %s-Felder", (field) => {
    const data = output();
    Object.assign(data.passengers[0]!, { [field]: "private" });
    expect(() => conductorProjectionRuntimeFromAddon({ projectConductorPassengers: () => JSON.stringify(data) }).project(input)).toThrow("Transportvertrag");
  });

  it.each(["worldId", "periodId", "trainRunId", "operatorId", "demandStateHash", "operationalReceiptId", "seedHash", "releaseHash"] as const)("verweigert geänderte Bindung %s", (field) => {
    const data = output(); data.binding[field] = "foreign";
    expect(() => conductorProjectionRuntimeFromAddon({ projectConductorPassengers: () => JSON.stringify(data) }).project(input)).toThrow("Transportvertrag");
  });

  it("verweigert doppelte Fahrgastschlüssel und doppelt belegte Plätze", () => {
    const doubleInput = { ...input, interior: { ...input.interior, places: [...input.interior.places, { ...input.interior.places[0]!, placeId: "second" }] } };
    for (const second of [{ ...output().passengers[0]!, placeId: "second" }, { ...output().passengers[0]!, passengerKey: "other" }]) {
      const data = output(); data.passengers.push(second);
      expect(() => conductorProjectionRuntimeFromAddon({ projectConductorPassengers: () => JSON.stringify(data) }).project(doubleInput)).toThrow("Transportvertrag");
    }
  });

  it("reicht keine privaten Fehlermeldungen aus dem Addon weiter", () => {
    const runtime = conductorProjectionRuntimeFromAddon({ projectConductorPassengers() { throw new Error("fareFact invalid passenger-secret"); } });
    expect(() => runtime.project(input)).toThrow("Der Fahrgastkern konnte die belegte Projektion nicht bestätigen.");
  });

  it("besitzt keinen Ersatzkern bei fehlendem Addon", () => {
    expect(() => loadConductorProjectionRuntime("relative.node")).toThrow("Absoluter");
  });
});
