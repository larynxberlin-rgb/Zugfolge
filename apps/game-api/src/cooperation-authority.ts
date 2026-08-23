import { validateWorldBlueprint, type AlphaWorldBlueprint } from "@zugfolge/alpha";
import {
  DatabaseCooperationAuthority,
  type ContractAuthorityDecision,
  type ContractOfferInput,
  type ContractPaymentAuthorityInput,
  type CooperationAuthority,
} from "@zugfolge/cooperation";
import {
  alphaWorldProfiles,
  domainEvents,
  fleetWorldCheckpoints,
  operators,
  regionalSimulationStates,
  vehicleAssets,
  type VehicleAsset,
  type VehicleMarketListing,
} from "@zugfolge/db";
import {
  PUBLIC_ENTRY_FACILITY_SCHEMA,
  assertOperatorActionAllowed,
  decodeEconomyValue,
  loadEconomyWorldState,
  loadFleetProducerCheckpoint,
  type FleetMobilizationSnapshot,
} from "@zugfolge/economy";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { FleetAuthorityRelease } from "@zugfolge/runtime-native";
import { and, desc, eq, inArray } from "drizzle-orm";

export interface CooperationResourceOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export interface PublicEntryFacilityOption extends CooperationResourceOption {
  readonly lotId: string;
  readonly formationId: string;
  readonly personnelDutyIds: readonly string[];
  readonly pathReservationIds: readonly string[];
}

export interface CooperationResourceCatalog {
  readonly schemaVersion: "zugfolge-cooperation-resource-catalog/v1";
  readonly worldId: string;
  readonly operatorId: string;
  readonly fleetRevision: number | null;
  readonly fleetSnapshotHash: string | null;
  readonly trainRuns: readonly CooperationResourceOption[];
  readonly connectionTrainRuns: readonly CooperationResourceOption[];
  readonly formations: readonly CooperationResourceOption[];
  readonly publicEntryFacilities: readonly PublicEntryFacilityOption[];
  readonly personnelDuties: readonly CooperationResourceOption[];
  readonly pathReceipts: readonly CooperationResourceOption[];
  readonly disruptions: readonly CooperationResourceOption[];
  readonly rentableVehicles: readonly CooperationResourceOption[];
  readonly assistanceVehicles: readonly CooperationResourceOption[];
}

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

interface DisruptionLogRow {
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: unknown;
}

function disruptionIdentifier(payload: unknown): string | undefined {
  const value = record(payload);
  const id = value?.["disruptionId"] ?? value?.["disruption_id"] ?? value?.["id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Letztes apply/clear je Kennung; eine Freigabe darf nicht als aktive Hilfeleistung fortleben. */
function activeDisruptionRows(rows: readonly DisruptionLogRow[]): readonly DisruptionLogRow[] {
  const active = new Map<string, DisruptionLogRow>();
  for (const row of [...rows].sort((left, right) => left.sequence - right.sequence)) {
    const id = disruptionIdentifier(row.payload);
    if (id === undefined) continue;
    if (row.eventType === "disruption.applied") active.set(id, row);
    else if (row.eventType === "disruption.cleared") active.delete(id);
  }
  return [...active.values()].sort((left, right) => left.sequence - right.sequence);
}

function containsIdentifier(value: unknown, names: readonly string[], expected: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsIdentifier(entry, names, expected));
  const object = record(value);
  if (object === undefined) return false;
  return Object.entries(object).some(([key, entry]) =>
    (names.includes(key) && entry === expected) || containsIdentifier(entry, names, expected),
  );
}

function hasBindings(value: unknown): boolean {
  const bindings = record(value);
  if (bindings === undefined) return true;
  return Object.values(bindings).some((entry) => Array.isArray(entry) ? entry.length > 0 : entry !== null);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function option(id: string, label: string, detail: string): CooperationResourceOption {
  return Object.freeze({ id, label, detail });
}

function sortOptions(values: readonly CooperationResourceOption[]): readonly CooperationResourceOption[] {
  return [...values].sort((left, right) => left.label.localeCompare(right.label, "de") || left.id.localeCompare(right.id));
}

/**
 * Erzeugt nur vollständige, vom signierten Weltlos und vom autoritativen
 * Flottensnapshot gemeinsam gedeckte Anschubpakete. Die Gebotsroute prüft das
 * gewählte Paket zusätzlich gegen Linie und Betriebsbeginn der Ausschreibung.
 */
export function publicEntryFacilityOptions(
  blueprint: AlphaWorldBlueprint,
  snapshot: FleetMobilizationSnapshot,
): readonly PublicEntryFacilityOption[] {
  const policy = blueprint.entryFacilityPolicy;
  if (
    policy?.schemaVersion !== PUBLIC_ENTRY_FACILITY_SCHEMA
    || policy.mode !== "award-contingent-wet-lease"
    || policy.providerOperatorId !== "public"
    || policy.costBasis !== "formation-operating-cost"
  ) return [];
  const result: PublicEntryFacilityOption[] = [];
  for (const lot of blueprint.lots) {
    const vehicleIds = new Set(lot.vehicleIds);
    const dutyIds = new Set(lot.personnelDutyIds);
    const receiptIds = new Set(lot.pathReceiptIds);
    const reservations = snapshot.pathReservations.filter((entry) =>
      entry.operatorId === "public"
      && entry.status === "confirmed"
      && entry.pathReceiptId !== undefined
      && receiptIds.has(entry.pathReceiptId));
    for (const formation of snapshot.formations) {
      if (
        formation.operatorId !== "public"
        || formation.procurement !== "delivered"
        || !["available", "committed"].includes(formation.availability)
        || formation.vehicleIds.length === 0
        || !formation.vehicleIds.every((vehicleId) => vehicleIds.has(vehicleId))
        || formation.pathReceiptId === undefined
        || !receiptIds.has(formation.pathReceiptId)
      ) continue;
      const duties = snapshot.personnelDuties.filter((entry) =>
        entry.operatorId === "public"
        && entry.status === "ready"
        && dutyIds.has(entry.id)
        && entry.formationIds.includes(formation.id)
        && entry.pathReceiptId !== undefined
        && receiptIds.has(entry.pathReceiptId));
      if (duties.length === 0 || reservations.length === 0) continue;
      const lines = formation.serviceLineIds.join(" / ") || lot.lotId;
      result.push(Object.freeze({
        id: `${lot.lotId}:${formation.id}`,
        lotId: lot.lotId,
        formationId: formation.id,
        label: `Öffentlicher Anschubvertrag · ${lines}`,
        detail: `${formation.characteristics.seats.toLocaleString("de-DE")} Sitzplätze · Wet-Lease nur bei Zuschlag · Betriebskosten werden dem EVU zugerechnet`,
        personnelDutyIds: Object.freeze(duties.map((entry) => entry.id)),
        pathReservationIds: Object.freeze(reservations.map((entry) => entry.id)),
      }));
    }
  }
  return Object.freeze(result.sort((left, right) => left.lotId.localeCompare(right.lotId, "de") || left.label.localeCompare(right.label, "de") || left.formationId.localeCompare(right.formationId)));
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

  private async trainOperators(worldId: string): Promise<ReadonlyMap<string, string>> {
    const rows = await this.db.select({ state: regionalSimulationStates.state }).from(regionalSimulationStates).where(
      eq(regionalSimulationStates.worldId, worldId),
    );
    const result = new Map<string, string>();
    for (const row of rows) {
      const trains = record(row.state)?.["trains"];
      if (!Array.isArray(trains)) continue;
      for (const train of trains) {
        const value = record(train);
        const id = value?.["id"] ?? value?.["trainRunId"];
        const operatorId = value?.["operator"] ?? value?.["operatorId"];
        if (typeof id !== "string" || typeof operatorId !== "string") continue;
        const existing = result.get(id);
        result.set(id, existing === undefined || existing === operatorId ? operatorId : "");
      }
    }
    return result;
  }

  private async publicEntryFacilities(worldId: string): Promise<readonly PublicEntryFacilityOption[]> {
    const [profile] = await this.db.select({
      blueprint: alphaWorldProfiles.blueprint,
      blueprintHash: alphaWorldProfiles.blueprintHash,
      deploymentHash: alphaWorldProfiles.deploymentHash,
      state: alphaWorldProfiles.state,
    }).from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1);
    if (profile?.state !== "running" || profile.deploymentHash === null || !/^[a-f0-9]{64}$/.test(profile.deploymentHash)) return [];
    try {
      const blueprint = decodeEconomyValue(profile.blueprint) as AlphaWorldBlueprint;
      if (validateWorldBlueprint(blueprint) !== profile.blueprintHash) return [];
      const checkpoint = await loadFleetProducerCheckpoint(this.db as never, worldId);
      return checkpoint === undefined ? [] : publicEntryFacilityOptions(blueprint, checkpoint.snapshot);
    } catch {
      return [];
    }
  }

  /**
   * Spielerlesemodell für Vertragsgegenstände. Interne Kennungen bleiben
   * Werte der Auswahl, während die sichtbaren Texte ausschließlich aus den
   * autoritativen, weltgebundenen M4-/M5-/Release-/Eventquellen stammen.
   */
  async resourceCatalog(worldId: string, operatorId: string): Promise<CooperationResourceCatalog> {
    const [checkpoint, regionalRows, disruptionRows, vehicles, operatorRows, publicEntryFacilities] = await Promise.all([
      this.db.select({ revision: fleetWorldCheckpoints.revision, state: fleetWorldCheckpoints.state, snapshotHash: fleetWorldCheckpoints.snapshotHash })
        .from(fleetWorldCheckpoints).where(eq(fleetWorldCheckpoints.worldId, worldId))
        .orderBy(desc(fleetWorldCheckpoints.revision)).limit(1),
      this.db.select({ state: regionalSimulationStates.state }).from(regionalSimulationStates)
        .where(eq(regionalSimulationStates.worldId, worldId)),
      this.db.select({
        sequence: domainEvents.sequence,
        eventType: domainEvents.eventType,
        payload: domainEvents.payload,
      }).from(domainEvents).where(and(
        eq(domainEvents.worldId, worldId),
        inArray(domainEvents.eventType, ["disruption.applied", "disruption.cleared"]),
      )),
      this.db.select().from(vehicleAssets).where(and(
        eq(vehicleAssets.worldId, worldId), eq(vehicleAssets.holderOperatorId, operatorId),
      )),
      this.db.select({ id: operators.id, name: operators.name }).from(operators).where(eq(operators.worldId, worldId)),
      this.publicEntryFacilities(worldId),
    ]);
    const release = this.fleetReleases[worldId];
    const state = record(checkpoint[0]?.state);
    const formationState = record(state?.["formations"]) ?? {};
    const dutyState = record(state?.["personnelDuties"]) ?? {};
    const receipts = release?.pathReceipts.filter((entry) => entry.operatorId === operatorId && entry.decision === "confirmed") ?? [];
    const receiptIds = new Set(receipts.map((entry) => entry.id));
    const poolIds = new Set((release?.personnelPools ?? []).filter((entry) => entry.operatorId === operatorId).map((entry) => entry.id));
    const operatorNames = new Map(operatorRows.map((entry) => [entry.id, entry.name]));

    const allTrains: CooperationResourceOption[] = [];
    const ownTrains: CooperationResourceOption[] = [];
    for (const row of regionalRows) {
      const trains = record(row.state)?.["trains"];
      if (!Array.isArray(trains)) continue;
      for (const rawTrain of trains) {
        const train = record(rawTrain);
        const id = train?.["id"] ?? train?.["trainRunId"];
        if (typeof id !== "string") continue;
        const trainNumber = text(train?.["trainNumber"], "Zugfahrt");
        const operator = text(train?.["operator"], "EVU unbekannt");
        const nextStop = text(train?.["nextOperatingPoint"], "ohne nächsten Betriebspunkt");
        const entry = option(id, `${trainNumber} nach ${nextStop}`, `${text(train?.["category"], "Zug")} · ${text(train?.["status"], "Status unbekannt")} · ${operatorNames.get(operator) ?? "EVU unbekannt"}`);
        allTrains.push(entry);
        if (operator === operatorId) ownTrains.push(entry);
      }
    }

    const formations = Object.entries(formationState).flatMap(([id, raw]) => {
      const formation = record(raw);
      if (formation === undefined) return [];
      const pathReceiptId = formation?.["pathReceiptId"];
      if (typeof pathReceiptId !== "string" || !receiptIds.has(pathReceiptId)) return [];
      const receipt = receipts.find((entry) => entry.id === pathReceiptId)!;
      const vehicleCount = strings(formation["vehicleIds"]).length;
      const lines = receipt.serviceLineIds.join(" / ") || "ohne Linienbindung";
      return [option(id, `Formation für ${lines}`, `${vehicleCount} Fahrzeug${vehicleCount === 1 ? "" : "e"} · Trasse bestätigt`)];
    });
    const readableWindow = (validFrom: unknown, validUntil: unknown): string => {
      const from = typeof validFrom === "number" && Number.isSafeInteger(validFrom) ? validFrom : undefined;
      const until = typeof validUntil === "number" && Number.isSafeInteger(validUntil) ? validUntil : undefined;
      if (from === undefined || until === undefined || until <= from) return "Gültigkeitszeitraum nicht verfügbar";
      const days = Math.ceil((until - from) / 86_400);
      return `für ${days} Betriebstag${days === 1 ? "" : "e"} gültig`;
    };
    const personnelDuties = Object.entries(dutyState).flatMap(([id, raw]) => {
      const duty = record(raw);
      if (duty === undefined) return [];
      const poolId = duty?.["personnelPoolId"];
      const pathReceiptId = duty?.["pathReceiptId"];
      if (typeof poolId !== "string" || !poolIds.has(poolId) || typeof pathReceiptId !== "string" || !receiptIds.has(pathReceiptId)) return [];
      return [option(id, `Personaldienst für ${strings(duty["formationIds"]).length} Formation(en)`, readableWindow(duty["validFrom"], duty["validUntil"]))];
    });
    const pathReceipts = receipts.map((receipt) => option(
      receipt.id,
      `Trasse ${receipt.serviceLineIds.join(" / ") || "ohne Linienkennung"}`,
      `bestätigt · ${readableWindow(receipt.validFrom, receipt.validUntil)}`,
    ));
    const disruptions = activeDisruptionRows(disruptionRows).flatMap(({ payload }) => {
      const value = record(payload);
      const id = value?.["disruptionId"] ?? value?.["disruption_id"] ?? value?.["id"];
      const operatorIds = strings(value?.["operatorIds"]);
      if (typeof id !== "string" || (operatorIds.length > 0 && !operatorIds.includes(operatorId))) return [];
      return [option(
        id,
        text(value?.["fineCauseLabel"] ?? value?.["fineCauseId"] ?? value?.["cause"], "Betriebsstörung"),
        `${text(value?.["effect"], "betriebliche Einschränkung")} · ${text(value?.["affectedResource"], "Ressource unbekannt")}`,
      )];
    });
    const vehicleOption = (vehicle: VehicleAsset) => option(
      vehicle.vehicleId,
      `Baureihe ${vehicle.classDesignation}`,
      `${(vehicle.conditionBasisPoints / 100).toLocaleString("de-DE")} % Zustand · im Besitz des handelnden EVU`,
    );
    const rentableVehicles = vehicles
      .filter((vehicle) => vehicle.ownerOperatorId === operatorId && !hasBindings(vehicle.bindings))
      .map(vehicleOption);
    const assistanceVehicles = vehicles.map(vehicleOption);

    return Object.freeze({
      schemaVersion: "zugfolge-cooperation-resource-catalog/v1",
      worldId,
      operatorId,
      fleetRevision: checkpoint[0]?.revision ?? null,
      fleetSnapshotHash: checkpoint[0]?.snapshotHash ?? null,
      trainRuns: sortOptions(ownTrains),
      connectionTrainRuns: sortOptions(allTrains),
      formations: sortOptions(formations),
      publicEntryFacilities,
      personnelDuties: sortOptions(personnelDuties),
      pathReceipts: sortOptions(pathReceipts),
      disruptions: sortOptions(disruptions),
      rentableVehicles: sortOptions(rentableVehicles),
      assistanceVehicles: sortOptions(assistanceVehicles),
    });
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

    const trains = await this.trainOperators(input.worldId);
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
        if (trains.get(arrival) !== input.offereeOperatorId || trains.get(onward) !== input.offerorOperatorId) {
          return denied("train_run_ownership", "Ankommende Zugfahrt muss dem empfangenden und weiterführende Zugfahrt dem anbietenden EVU gehören.");
        }
      }
      return VERIFIED;
    }

    if (input.contractType === "disruption-assistance") {
      const disruptionId = subject["disruptionId"];
      if (typeof disruptionId !== "string") return denied("disruption_missing", "Störungskennung fehlt.");
      const events = await this.db.select({
        sequence: domainEvents.sequence,
        eventType: domainEvents.eventType,
        payload: domainEvents.payload,
      }).from(domainEvents).where(and(
        eq(domainEvents.worldId, input.worldId),
        inArray(domainEvents.eventType, ["disruption.applied", "disruption.cleared"]),
      ));
      if (!activeDisruptionRows(events).some(
        (event) => containsIdentifier(event.payload, ["disruptionId", "disruption_id", "id"], disruptionId),
      )) {
        return denied("disruption_missing", `Störung '${disruptionId}' ist nicht im autoritativen Event-Log aktiv.`);
      }
      if (strings(subject["trainRunIds"]).some((trainId) => !trains.has(trainId))) {
        return denied("train_run_missing", "Mindestens eine Ersatzzugfahrt existiert nicht im regionalen Zustand.");
      }
      if (strings(subject["trainRunIds"]).some((trainId) => trains.get(trainId) !== input.offerorOperatorId)) {
        return denied("train_run_ownership", "Ersatzzugfahrten müssen dem anbietenden EVU gehören.");
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
    if (strings(subject["trainRunIds"]).some((trainId) => trains.get(trainId) !== input.offerorOperatorId)) {
      return denied("train_run_ownership", "Traktionszugfahrten müssen dem anbietenden EVU gehören.");
    }
    return VERIFIED;
  }

  async verifyContractPayment(input: ContractPaymentAuthorityInput): Promise<ContractAuthorityDecision> {
    const economy = await loadEconomyWorldState(this.db as never, input.worldId);
    if (economy === undefined) {
      return denied(
        "economy_state_missing",
        "Autoritativer Economy-Zustand der Welt fehlt; Vertragszahlung wird nicht ausgeführt.",
      );
    }
    try {
      // Entgeltliche EVU-Verträge begründen wie Fahrzeugkäufe eine neue
      // Zahlungsverpflichtung. Bis ein eigener contract-payment-Aktionstyp
      // existiert, ist daher die strengere bestehende Kaufsperre maßgeblich.
      assertOperatorActionAllowed(economy, input.payerOperatorId, "purchase");
    } catch {
      return denied("contract_payment_blocked", "Economy-Zustand sperrt neue Vertragszahlungen dieses EVU.");
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
    if (state === undefined) return denied("fleet_state_missing", "Autoritativer Flottenzustand ist noch nicht initialisiert.");
    const formations = record(state["formations"]);
    if (formations === undefined) return denied("fleet_state_invalid", "Flottenzustand enthaelt keine autoritativen Formationen.");
    if (Object.values(formations).some((formation) => strings(record(formation)?.["vehicleIds"]).includes(input.vehicle.vehicleId))) {
      return denied("vehicle_formation_bound", "Fahrzeug ist in einer autoritativen Formation gebunden.");
    }
    return VERIFIED;
  }

  async verifyVehicleTransfer(input: { readonly worldId: string; readonly vehicle: VehicleAsset; readonly listing: VehicleMarketListing; readonly buyerOperatorId: string; readonly atS: number }): Promise<ContractAuthorityDecision> {
    const economy = await loadEconomyWorldState(this.db as never, input.worldId);
    if (economy === undefined) return denied("economy_state_missing", "Autoritativer Economy-Zustand der Welt fehlt; Kauf wird nicht ausgeführt.");
    try {
      assertOperatorActionAllowed(economy, input.buyerOperatorId, "purchase");
    } catch {
      return denied("purchase_blocked", "Economy-Zustand sperrt Käufe dieses EVU.");
    }
    const base = await this.base.verifyVehicleTransfer(input);
    if (!base.permitted) return base;
    return this.verifyVehicleListing({ worldId: input.worldId, vehicle: input.vehicle, listingType: input.listing.listingType, atS: input.atS });
  }

  async verifyVehicleReversal(input: {
    readonly worldId: string;
    readonly vehicle: VehicleAsset;
    readonly listing: VehicleMarketListing;
    readonly originalTransferId: string;
    readonly originalTransferredAtS: number;
    readonly assetBeforeHash: string;
    readonly reasonCode: string;
    readonly atS: number;
  }): Promise<ContractAuthorityDecision> {
    const evidence = await this.db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(
      eq(domainEvents.worldId, input.worldId),
      eq(domainEvents.eventType, "vehicle.defect-confirmed"),
    ));
    const confirmed = evidence.some(({ payload }) => {
      const value = record(payload);
      const observedAtS = value?.["observedAtS"];
      const confirmedAtS = value?.["confirmedAtS"];
      return value?.["vehicleId"] === input.vehicle.vehicleId
        && value["listingId"] === input.listing.id
        && value["transferId"] === input.originalTransferId
        && value["disclosureHash"] === input.listing.disclosureHash
        && value["assetBeforeHash"] === input.assetBeforeHash
        && value["reasonCode"] === input.reasonCode
        && value["disclosed"] === false
        && Number.isSafeInteger(observedAtS)
        && Number.isSafeInteger(confirmedAtS)
        && (observedAtS as number) <= input.originalTransferredAtS
        && (confirmedAtS as number) >= (observedAtS as number)
        && (confirmedAtS as number) <= input.atS;
    });
    if (!confirmed) {
      return denied("reversal_evidence_missing", "Kein serverautoritativ bestätigter Mangel passt zu Fahrzeug, Angebot, Offenlegungsbeleg und Grund.");
    }
    if (hasBindings(input.vehicle.bindings)) {
      return denied("vehicle_bound", "Fahrzeug besitzt neue Bindungen und kann nicht automatisch rückabgewickelt werden.");
    }
    const state = await this.fleetState(input.worldId);
    if (state === undefined) return denied("fleet_state_missing", "Autoritativer Flottenzustand ist noch nicht initialisiert.");
    const formations = record(state["formations"]);
    if (formations === undefined) return denied("fleet_state_invalid", "Flottenzustand enthaelt keine autoritativen Formationen.");
    if (Object.values(formations).some((formation) => strings(record(formation)?.["vehicleIds"]).includes(input.vehicle.vehicleId))) {
      return denied("vehicle_formation_bound", "Fahrzeug ist in einer autoritativen Formation gebunden.");
    }
    return VERIFIED;
  }
}
