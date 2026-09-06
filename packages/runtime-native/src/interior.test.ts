import { describe, expect, it } from "vitest";
import { conductorInteriorRuntimeFromAddon, ConductorInteriorError, loadConductorInteriorRuntime, type ConductorInteriorAddon } from "./interior.js";
import type { BuildInteriorLayoutInputV1, InteriorLayoutV1, ProjectConductorPassengersInputV2 } from "./interior-types.js";

const hash = "a".repeat(64);
const binding = { worldId: "world", periodId: "period", operatorId: "operator", formationId: "formation",
  formationRevision: 1, fleetStateHash: hash, fleetAuthorityReleaseId: "fleet", fleetAuthorityReleaseHash: hash,
  mobilizationSnapshotHash: hash, geometryPolicyHash: hash, artReleaseId: "art", artManifestHash: hash };
const point = { vehicleId: "vehicle", bodyId: "body", deckId: "main" as const, xMm: 2000, yMm: 1500 };
const capacity = { standardSeats: 1, standardStanding: 0, premiumSeats: 0, wheelchairSpaces: 0, bicycleSpaces: 0, strollerSpaces: 0 };
// Transport-Gegentest, ausdrücklich kein positiver Fach-/Abnahmenachweis.
const layout: InteriorLayoutV1 = { schemaVersion: "interior-layout/v1", binding, layoutId: "layout", layoutHash: hash, capacity,
  vehicles: [{ vehicleId: "vehicle", vehicleTypeId: 1, configuration: null, configurationHash: null,
    artFamily: "regional-single", capacity, bodies: [{ bodyId: "body", vehicleId: "vehicle", lengthMm: 20000, widthMm: 3000,
      vehicleOffsetMm: 0, formationOffsetMm: 0, reversed: false, deckIds: ["main"], entranceDeckId: "main",
      passengerAccessible: true, frontGangway: true, rearGangway: true, gapAfterMm: 0 }] }],
  passengerPlaces: [{ ...point, placeId: "seat", comfortClass: "standard", kind: "seat", spaceNeeds: ["ordinary"] }],
  specialBays: [], obstacles: [{ obstacleId: "seat-obstacle", vehicleId: "vehicle", bodyId: "body", deckId: "main", kind: "seat", rect: { xMm: 1000, yMm: 100, lengthMm: 500, widthMm: 450 } }],
  nodes: [{ nodeId: "entrance", point }], edges: [], interactions: [], doors: [], seats: [{ placeId: "seat", obstacleId: "seat-obstacle", facing: "forward" }], entranceNodeId: "entrance" };
const buildInput = { binding, mobilization: { formations: [{ id: "formation", vehicleIds: ["vehicle"] }] } } as unknown as BuildInteriorLayoutInputV1;
function addon(value: unknown): ConductorInteriorAddon {
  const call = () => JSON.stringify(value);
  return { buildConductorInterior: call, bindConductorInterior: call, projectConductorPassengersV2: call, findConductorInteriorPath: call, checkConductorInteriorMovement: call };
}
describe("strikter M15.4-Transport", () => {
  it("verwirft fremde Bindungen, Offenlegungsfelder und ungültige Referenzen", () => {
    expect(conductorInteriorRuntimeFromAddon(addon(layout)).build(buildInput)).toEqual(layout);
    for (const mutation of [
      (value: any) => { value.binding.periodId = "foreign"; },
      (value: any) => { value.vehicles[0].privateHolding = "secret"; },
      (value: any) => { value.passengerPlaces[0].deckId = "upper"; },
      (value: any) => { value.entranceNodeId = "missing"; },
      (value: any) => { value.passengerPlaces[0].xMm = 20000.5; },
      (value: any) => { value.nodes.push(value.nodes[0]); },
      (value: any) => { value.edges.push({ edgeId: "edge", fromNodeId: "entrance", toNodeId: "missing", kind: "walk", lengthMm: 1, wheelchairAccessible: true }); },
    ]) {
      const value = structuredClone(layout); mutation(value);
      expect(() => conductorInteriorRuntimeFromAddon(addon(value)).build(buildInput)).toThrow(/Transportvertrag/);
    }
  });
  it("erhält nur strukturierte native Fachdiagnosen", () => {
    const native = addon(null);
    native.buildConductorInterior = () => { throw new Error(JSON.stringify({ code: "vehicle_configuration_missing", vehicleId: "vehicle" })); };
    expect(() => conductorInteriorRuntimeFromAddon(native).build(buildInput)).toThrow(ConductorInteriorError);
    try { conductorInteriorRuntimeFromAddon(native).build(buildInput); } catch (error) {
      expect(error).toMatchObject({ code: "vehicle_configuration_missing", vehicleId: "vehicle" });
    }
    for (const message of ["private raw state secret", JSON.stringify({ code: "bad", private: "secret" }), '{"code":"secret with spaces"}']) {
      native.buildConductorInterior = () => { throw new Error(message); };
      expect(() => conductorInteriorRuntimeFromAddon(native).build(buildInput)).toThrow("interior_native_rejected");
    }
  });
  it("verwirft beschädigte JSON-Ausgaben ohne deren Inhalt offenzulegen", () => {
    const native = addon(null); native.buildConductorInterior = () => '{"secret": not-json';
    expect(() => conductorInteriorRuntimeFromAddon(native).build(buildInput)).toThrow("Innenraumantwort verletzt den versionierten Transportvertrag.");
  });
  it("prüft Wege gegen konkrete Knoten und Kanten", () => {
    const input = { schemaVersion: "conductor-interior-path-input/v1" as const, layout, expectedLayoutHash: hash,
      fromNodeId: "entrance", toNodeId: "entrance", wheelchair: false };
    const result = { schemaVersion: "interior-path/v1", layoutHash: hash, nodeIds: ["entrance"], edgeIds: [], lengthMm: 0 };
    expect(conductorInteriorRuntimeFromAddon(addon(result)).path(input)).toEqual(result);
    for (const value of [{ ...result, lengthMm: 1 }, { ...result, layoutHash: "b".repeat(64) }, { ...result, nodeIds: ["missing"] }])
      expect(() => conductorInteriorRuntimeFromAddon(addon(value)).path(input)).toThrow(/Transportvertrag/);
  });
  it("verwirft widersprüchliche Bewegungsantworten und fremde Layouthashes", () => {
    const input = { schemaVersion: "conductor-interior-movement-input/v1" as const, layout, expectedLayoutHash: hash,
      from: point, to: point, transitionEdgeId: null, wheelchair: false };
    const result = { schemaVersion: "interior-movement-result/v1", layoutHash: hash, allowed: false, issue: "interior_collision" };
    expect(conductorInteriorRuntimeFromAddon(addon(result)).movement(input)).toEqual(result);
    for (const value of [{ ...result, allowed: true }, { ...result, issue: null }, { ...result, layoutHash: "b".repeat(64) }])
      expect(() => conductorInteriorRuntimeFromAddon(addon(value)).movement(input)).toThrow(/Transportvertrag/);
  });
  it("bindet V2-Fahrgäste an bekannte Plätze und exklusive Sonderflächen", () => {
    const passengerBinding = { worldId: "world", periodId: "period", demandReleaseId: "demand", releaseHash: hash,
      seedHash: hash, trainRunId: "train", operatorId: "operator", manifestRevision: 1, demandStateHash: hash, operationalReceiptId: "receipt" };
    const input: ProjectConductorPassengersInputV2 = { schemaVersion: "conductor-passenger-projection-input/v2", binding: passengerBinding,
      evaluation: { nowMs: 100 }, service: {}, interior: { schemaVersion: "interior-passenger-places/v2", worldId: "world", trainRunId: "train",
        layoutId: "layout", sourceLayoutHash: hash, layoutHash: hash, places: layout.passengerPlaces, specialBays: [] } };
    const result = { schemaVersion: "passenger-projection/v2", binding: passengerBinding, segmentId: "segment", fromStopId: "from", toStopId: "to",
      layoutId: "layout", sourceLayoutHash: hash, layoutHash: hash, asOfMs: 100, phase: "in_transit", currentStopId: null, stateHash: hash,
      passengers: [{ ...point, passengerKey: "person", placeId: "seat", spaceId: null, comfortClass: "standard", spaceNeeds: "ordinary", posture: "seated", appearanceVariant: 1, activity: "onboard" }] };
    expect(conductorInteriorRuntimeFromAddon(addon(result)).project(input)).toEqual(result);
    for (const mutation of [
      (value: any) => { value.passengers[0].ticket = "private"; },
      (value: any) => { value.passengers[0].xMm++; },
      (value: any) => { value.passengers[0].placeId = "unknown"; },
      (value: any) => { value.passengers[0].spaceNeeds = "wheelchair"; },
      (value: any) => { value.passengers.push(value.passengers[0]); },
    ]) { const value = structuredClone(result); mutation(value); expect(() => conductorInteriorRuntimeFromAddon(addon(value)).project(input)).toThrow(/Transportvertrag/); }
  });
  it("hat keinen JS-Ersatzkern bei fehlendem Addon", () => {
    expect(() => loadConductorInteriorRuntime("relative.node")).toThrow(/Absoluter/);
  });
});
