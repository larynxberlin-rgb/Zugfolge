import type { AlphaWorldBlueprint } from "@zugfolge/alpha";
import type { FleetMobilizationSnapshot } from "@zugfolge/economy";
import { describe, expect, it } from "vitest";

import { publicEntryFacilityOptions } from "./cooperation-authority.js";

const blueprint = {
  schemaVersion: "zugfolge-alpha-world-blueprint/v2",
  entryFacilityPolicy: {
    schemaVersion: "zugfolge-public-entry-facility/v1",
    mode: "award-contingent-wet-lease",
    providerOperatorId: "public",
    costBasis: "formation-operating-cost",
  },
  lots: [{
    lotId: "S5", vehicleIds: ["vehicle-1"], personnelDutyIds: ["duty-1"], pathReceiptIds: ["receipt-1"],
  }],
} as unknown as AlphaWorldBlueprint;

const snapshot: FleetMobilizationSnapshot = {
  schema: "zugfolge-fleet-mobilization/v1", worldId: "world", revision: 7, producedAt: 100,
  formations: [{
    id: "formation-1", operatorId: "public", vehicleIds: ["vehicle-1"], pathReceiptId: "receipt-1",
    serviceLineIds: ["S5"], availability: "available", procurement: "delivered", availableFrom: 0, availableUntil: 10_000,
    characteristics: {
      seats: 200, firstClassBasisPoints: 1_000, accessible: true, bicyclePlaces: 12, wheelchairPlaces: 2,
      equipment: [], vehicleAgeYears: 2, maximumSpeedKph: 160, operatingCostCentsPerTrainKm: 800,
      homologatedLineIds: ["S5"], maintenanceValidUntil: 10_000, traction: "electric", replacementPlan: false,
    },
  }],
  personnelDuties: [{
    id: "duty-1", operatorId: "public", formationIds: ["formation-1"], pathReceiptId: "receipt-1",
    status: "ready", validFrom: 0, validUntil: 10_000,
  }],
  pathReservations: [{
    id: "reservation-1", operatorId: "public", pathReceiptId: "receipt-1", serviceLineIds: ["S5"],
    status: "confirmed", validFrom: 0, validUntil: 10_000,
  }],
};

describe("öffentliche Anschubpakete", () => {
  it("bindet Formation, Personal und Trasse an dasselbe signierte Los", () => {
    expect(publicEntryFacilityOptions(blueprint, snapshot)).toEqual([expect.objectContaining({
      id: "S5:formation-1", lotId: "S5", formationId: "formation-1",
      personnelDutyIds: ["duty-1"], pathReservationIds: ["reservation-1"],
    })]);
  });

  it("blendet unvollständige oder losfremde Ressourcen aus", () => {
    expect(publicEntryFacilityOptions(blueprint, { ...snapshot, personnelDuties: [] })).toEqual([]);
    expect(publicEntryFacilityOptions(blueprint, {
      ...snapshot,
      formations: snapshot.formations.map((formation) => ({ ...formation, vehicleIds: ["vehicle-foreign"] })),
    })).toEqual([]);
  });
});
