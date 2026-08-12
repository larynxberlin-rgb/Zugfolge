import {
  DatabaseCooperationAuthority,
  type ContractAuthorityDecision,
  type ContractOfferInput,
  type CooperationAuthority,
} from "@zugfolge/cooperation";
import {
  domainEvents,
  fleetWorldCheckpoints,
  regionalSimulationStates,
  vehicleAssets,
  type VehicleAsset,
  type VehicleMarketListing,
} from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { FleetAuthorityRelease } from "@zugfolge/runtime-native";
import { and, desc, eq } from "drizzle-orm";

const VERIFIED: ContractAuthorityDecision = {
  permitted: true,
  code: "verified",
  explanation: "Eigentum, Personal, Trasse, Zugfahrt und Konfliktbeleg sind serverseitig geprüft.",
};

function denied(code: string, explanation: string): ContractAuthorityDecision {
  return { permitted: false, code, explanation };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function containsIdentifier(value: unknown, names: readonly string[], expected: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsIdentifier(entry, names, expected));
  const object = record(value);
  if (object === undefined) return false;
  return Object.entries(object).some(([key, entry]) =>
    (names.includes(key) && entry === expected) || containsIdentifier(entry, names, expected),
  );
}

export class GameCooperationAuthority implements CooperationAuthority {
  private readonly base = new DatabaseCooperationAuthority();

  constructor(
    private readonly db: IdentityDatabase,
    private readonly fleetReleases: Readonly<Record<string, FleetAuthorityRelease>>,
  ) {}

  private async fleetState(worldId: string): Promise<Readonly<Record<string, unknown>> | undefined> {
    const [checkpoint] = await this.db.select({ state: fleetWorldCheckpoints.state }).from(fleetWorldCheckpoints).where(
      eq(fleetWorldCheckpoints.worldId, worldId),
    ).orderBy(desc(fleetWorldCheckpoints.revision)).limit(1);
    return record(checkpoint?.state);
  }

  private async trainIdentifiers(worldId: string): Promise<ReadonlySet<string>> {
    const rows = await this.db.select({ state: regionalSimulationStates.state }).from(regionalSimulationStates).where(
      eq(regionalSimulationStates.worldId, worldId),
    );
    const result = new Set<string>();
    for (const row of rows) {
      const trains = record(row.state)?.["trains"];
      if (!Array.isArray(trains)) continue;
      for (const train of trains) {
        const value = record(train);
        const id = value?.["id"] ?? value?.["trainRunId"];
        if (typeof id === "string") result.add(id);
      }
    }
    return result;
  }

  async verifyContract(input: ContractOfferInput): Promise<ContractAuthorityDecision> {
    const subject = input.subject;
    if (input.contractType === "vehicle-rental") {
      for (const vehicleId of strings(subject["vehicleIds"])) {
        const [asset] = await this.db.select().from(vehicleAssets).where(and(
          eq(vehicleAssets.worldId, input.worldId), eq(vehicleAssets.vehicleId, vehicleId),
        )).limit(1);
        if (asset === undefined || asset.ownerOperatorId !== input.offerorOperatorId || asset.holderOperatorId !== input.offerorOperatorId) {
          return denied("vehicle_ownership", `Fahrzeug '${vehicleId}' steht nicht unbelastet im Eigentum und Besitz des anbietenden EVU.`);
        }
        const listing = await this.base.verifyVehicleListing({ worldId: input.worldId, vehicle: asset, listingType: "rental", atS: input.offeredAtS });
        if (!listing.permitted) return listing;
      }
      return VERIFIED;
    }

    const trains = await this.trainIdentifiers(input.worldId);
    if (input.contractType === "connection") {
      const connections = subject["connections"];
      if (!Array.isArray(connections)) return denied("connection_invalid", "Anschlussliste fehlt.");
      for (const connection of connections) {
        const value = record(connection);
        const arrival = value?.["arrivalTrainRunId"];
        const onward = value?.["onwardTrainRunId"];
        if (typeof arrival !== "string" || typeof onward !== "string" || !trains.has(arrival) || !trains.has(onward)) {
          return denied("train_run_missing", "Mindestens eine Anschlusszugfahrt existiert nicht im autoritativen regionalen Zustand.");
        }
      }
      return VERIFIED;
    }

    if (input.contractType === "disruption-assistance") {
      const disruptionId = subject["disruptionId"];
      if (typeof disruptionId !== "string") return denied("disruption_missing", "Störungskennung fehlt.");
      const events = await this.db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(
        eq(domainEvents.worldId, input.worldId), eq(domainEvents.eventType, "disruption.applied"),
      ));
      if (!events.some((event) => containsIdentifier(event.payload, ["disruptionId", "disruption_id", "id"], disruptionId))) {
        return denied("disruption_missing", `Störung '${disruptionId}' ist nicht im autoritativen Event-Log aktiv.`);
      }
      if (strings(subject["trainRunIds"]).some((trainId) => !trains.has(trainId))) {
        return denied("train_run_missing", "Mindestens eine Ersatzzugfahrt existiert nicht im regionalen Zustand.");
      }
      return this.verifyOwnedVehicles(input, strings(subject["vehicleIds"]));
    }

    const release = this.fleetReleases[input.worldId];
    if (release === undefined) return denied("fleet_release_missing", "Gepinnter Flotten-Authority-Release der Welt fehlt.");
    const state = await this.fleetState(input.worldId);
    if (state === undefined) return denied("fleet_state_missing", "Autoritativer Flottenzustand ist noch nicht initialisiert.");
    const formations = record(state["formations"]);
    const duties = record(state["personnelDuties"]);
    if (formations === undefined || duties === undefined) return denied("fleet_state_invalid", "Flottenzustand enthält keine Formationen oder Personaldienste.");

    const pathIds = strings(subject["pathReceiptIds"]);
    for (const pathId of pathIds) {
      const path = release.pathReceipts.find((entry) => entry.id === pathId);
      if (path === undefined || path.operatorId !== input.offerorOperatorId || path.decision !== "confirmed" || !/^[a-f0-9]{64}$/.test(path.conflictCheckHash)) {
        return denied("path_unverified", `Trassenbeleg '${pathId}' ist nicht bestätigt, konfliktgeprüft oder dem Anbieter zugeordnet.`);
      }
    }
    for (const formationId of strings(subject["formationIds"])) {
      const formation = record(formations[formationId]);
      if (formation === undefined || !pathIds.includes(String(formation["pathReceiptId"]))) {
        return denied("formation_unavailable", `Formation '${formationId}' ist nicht für einen Vertrags-Trassenbeleg materialisiert.`);
      }
      const ownership = await this.verifyOwnedVehicles(input, strings(formation["vehicleIds"]));
      if (!ownership.permitted) return ownership;
    }
    for (const dutyId of strings(subject["personnelDutyIds"])) {
      const duty = record(duties[dutyId]);
      const poolId = duty?.["personnelPoolId"];
      const pool = typeof poolId === "string" ? release.personnelPools.find((entry) => entry.id === poolId) : undefined;
      if (duty === undefined || pool === undefined || pool.operatorId !== input.offerorOperatorId || !pathIds.includes(String(duty["pathReceiptId"]))) {
        return denied("personnel_unavailable", `Personaldienst '${dutyId}' ist nicht qualifiziert oder nicht dem Anbieter zugeordnet.`);
      }
    }
    if (strings(subject["trainRunIds"]).some((trainId) => !trains.has(trainId))) {
      return denied("train_run_missing", "Mindestens eine Traktionszugfahrt existiert nicht im autoritativen regionalen Zustand.");
    }
    return VERIFIED;
  }

  private async verifyOwnedVehicles(input: ContractOfferInput, vehicleIds: readonly string[]): Promise<ContractAuthorityDecision> {
    for (const vehicleId of vehicleIds) {
      const [asset] = await this.db.select().from(vehicleAssets).where(and(
        eq(vehicleAssets.worldId, input.worldId), eq(vehicleAssets.vehicleId, vehicleId),
      )).limit(1);
      if (asset === undefined || asset.holderOperatorId !== input.offerorOperatorId) {
        return denied("vehicle_unavailable", `Fahrzeug '${vehicleId}' steht dem anbietenden EVU nicht zur Verfügung.`);
      }
    }
    return VERIFIED;
  }

  async verifyVehicleListing(input: { readonly worldId: string; readonly vehicle: VehicleAsset; readonly listingType: "sale" | "rental"; readonly atS: number }): Promise<ContractAuthorityDecision> {
    const base = await this.base.verifyVehicleListing(input);
    if (!base.permitted) return base;
    const state = await this.fleetState(input.worldId);
    const formations = record(state?.["formations"]);
    if (formations !== undefined && Object.values(formations).some((formation) => strings(record(formation)?.["vehicleIds"]).includes(input.vehicle.vehicleId))) {
      return denied("vehicle_formation_bound", "Fahrzeug ist in einer autoritativen Formation gebunden.");
    }
    return VERIFIED;
  }

  async verifyVehicleTransfer(input: { readonly worldId: string; readonly vehicle: VehicleAsset; readonly listing: VehicleMarketListing; readonly buyerOperatorId: string; readonly atS: number }): Promise<ContractAuthorityDecision> {
    const base = await this.base.verifyVehicleTransfer(input);
    if (!base.permitted) return base;
    return this.verifyVehicleListing({ worldId: input.worldId, vehicle: input.vehicle, listingType: input.listing.listingType, atS: input.atS });
  }

  async verifyVehicleReversal(input: { readonly worldId: string; readonly vehicle: VehicleAsset; readonly listing: VehicleMarketListing; readonly reasonCode: string; readonly atS: number }): Promise<ContractAuthorityDecision> {
    const base = await this.base.verifyVehicleReversal(input);
    if (!base.permitted) return base;
    return this.verifyVehicleListing({ worldId: input.worldId, vehicle: input.vehicle, listingType: input.listing.listingType, atS: input.atS });
  }
}
