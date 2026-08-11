import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import { fleetMobilizationSnapshots } from "@zugfolge/db";
import { and, desc, eq } from "drizzle-orm";

import type { MobilizationProof } from "./contracts.js";
import type { EconomyDatabase } from "./ledger.js";
import type { VehicleConcept } from "./tender.js";

export const FLEET_MOBILIZATION_SCHEMA = "zugfolge-fleet-mobilization/v1" as const;

export interface FleetFormationSnapshot {
  readonly id: string;
  readonly operatorId: string;
  readonly vehicleIds: readonly string[];
  readonly serviceLineIds: readonly string[];
  readonly availability: "available" | "committed" | "maintenance" | "retired";
  readonly procurement: "delivered" | "ordered" | "cancelled";
  readonly availableFrom: number;
  readonly availableUntil: number;
  readonly characteristics: {
    readonly seats: number;
    readonly firstClassBasisPoints: number;
    readonly accessible: boolean;
    readonly bicyclePlaces: number;
    readonly wheelchairPlaces: number;
    readonly equipment: readonly string[];
    readonly vehicleAgeYears: number;
    readonly maximumSpeedKph: number;
    readonly operatingCostCentsPerTrainKm: number;
    readonly homologatedLineIds: readonly string[];
    readonly maintenanceValidUntil: number;
    readonly traction: "electric" | "diesel" | "battery" | "hydrogen";
    readonly replacementPlan: boolean;
  };
}

export interface FleetPersonnelDutySnapshot {
  readonly id: string;
  readonly operatorId: string;
  readonly formationIds: readonly string[];
  readonly status: "ready" | "planned" | "uncovered";
  readonly validFrom: number;
  readonly validUntil: number;
}

export interface FleetPathReservationSnapshot {
  readonly id: string;
  readonly operatorId: string;
  readonly serviceLineIds: readonly string[];
  readonly status: "confirmed" | "requested" | "rejected";
  readonly validFrom: number;
  readonly validUntil: number;
}

export interface FleetMobilizationSnapshot {
  readonly schema: typeof FLEET_MOBILIZATION_SCHEMA;
  readonly worldId: string;
  readonly revision: number;
  readonly producedAt: number;
  readonly formations: readonly FleetFormationSnapshot[];
  readonly personnelDuties: readonly FleetPersonnelDutySnapshot[];
  readonly pathReservations: readonly FleetPathReservationSnapshot[];
}

export interface FleetMobilizationEnvelope {
  readonly snapshot: FleetMobilizationSnapshot;
  readonly snapshotHash: string;
}

export interface FleetSnapshotReference {
  readonly fleetRevision: number;
  readonly snapshotHash: string;
}

export interface FleetVehicleReference extends FleetSnapshotReference {
  readonly formationId: string;
}

export interface FleetMobilizationReference extends FleetSnapshotReference {
  readonly formationIds: readonly string[];
  readonly personnelDutyIds: readonly string[];
  readonly pathReservationIds: readonly string[];
}

export class FleetSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetSnapshotValidationError";
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FleetSnapshotValidationError(message);
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
}

function integer(value: unknown, name: string, minimum = 0): asserts value is number {
  invariant(Number.isSafeInteger(value) && (value as number) >= minimum, `${name} ist keine ganze Zahl >= ${minimum}.`);
}

/** Rust-Strings werden lexikografisch nach ihren UTF-8-Bytes geordnet. */
export function compareFleetUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function uniqueIds(values: readonly { readonly id: string }[], name: string): void {
  values.forEach((value, index) => nonEmpty(value.id, `${name}[${index}].id`));
  invariant(new Set(values.map((value) => value.id)).size === values.length, `${name} enthält doppelte IDs.`);
  invariant(values.every((value, index) => index === 0 || compareFleetUtf8(values[index - 1]!.id, value.id) < 0), `${name} ist nicht kanonisch nach ID sortiert.`);
}

function validWindow(from: unknown, until: unknown, name: string): void {
  integer(from, `${name}.from`);
  integer(until, `${name}.until`);
  invariant((until as number) > (from as number), `${name} ist kein positives, halboffenes Zeitfenster.`);
}

function validStringList(values: unknown, name: string, allowEmpty = false): asserts values is readonly string[] {
  invariant(Array.isArray(values) && (allowEmpty || values.length > 0), `${name} fehlt oder ist leer.`);
  values.forEach((value, index) => nonEmpty(value, `${name}[${index}]`));
  invariant(new Set(values).size === values.length, `${name} enthält doppelte IDs.`);
  invariant(values.every((value, index) => index === 0 || compareFleetUtf8(values[index - 1]!, value) < 0), `${name} ist nicht kanonisch sortiert.`);
}

/** Kanonisches JSON: identische M5-Nutzdaten ergeben sprachübergreifend denselben SHA-256. */
export function canonicalFleetJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFleetJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareFleetUtf8(left, right))
      .map(([key, item]) => {
        invariant(item !== undefined, `Kanonischer Snapshot enthält undefined in '${key}'.`);
        return `${JSON.stringify(key)}:${canonicalFleetJson(item)}`;
      })
      .join(",")}}`;
  }
  invariant(
    value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number",
    "Kanonischer Snapshot enthält einen nicht unterstützten Wert.",
  );
  if (typeof value === "number") invariant(Number.isSafeInteger(value), "Snapshot enthält keine sichere Ganzzahl.");
  return JSON.stringify(value);
}

export function fleetSnapshotHash(snapshot: FleetMobilizationSnapshot): string {
  return createHash("sha256").update(canonicalFleetJson(snapshot)).digest("hex");
}

export function validateFleetMobilizationSnapshot(snapshot: FleetMobilizationSnapshot): FleetMobilizationSnapshot {
  invariant(snapshot.schema === FLEET_MOBILIZATION_SCHEMA, "Unbekanntes M5-Snapshot-Schema.");
  nonEmpty(snapshot.worldId, "worldId");
  integer(snapshot.revision, "revision");
  integer(snapshot.producedAt, "producedAt");
  invariant(Array.isArray(snapshot.formations), "formations fehlt.");
  invariant(Array.isArray(snapshot.personnelDuties), "personnelDuties fehlt.");
  invariant(Array.isArray(snapshot.pathReservations), "pathReservations fehlt.");
  uniqueIds(snapshot.formations, "formations");
  uniqueIds(snapshot.personnelDuties, "personnelDuties");
  uniqueIds(snapshot.pathReservations, "pathReservations");

  for (const [index, formation] of snapshot.formations.entries()) {
    const name = `formations[${index}]`;
    nonEmpty(formation.operatorId, `${name}.operatorId`);
    validStringList(formation.vehicleIds, `${name}.vehicleIds`);
    validStringList(formation.serviceLineIds, `${name}.serviceLineIds`);
    invariant(["available", "committed", "maintenance", "retired"].includes(formation.availability), `${name}.availability ist unbekannt.`);
    invariant(["delivered", "ordered", "cancelled"].includes(formation.procurement), `${name}.procurement ist unbekannt.`);
    validWindow(formation.availableFrom, formation.availableUntil, `${name}.availabilityWindow`);
    integer(formation.characteristics.seats, `${name}.characteristics.seats`, 1);
    integer(formation.characteristics.firstClassBasisPoints, `${name}.characteristics.firstClassBasisPoints`);
    invariant(formation.characteristics.firstClassBasisPoints <= 10_000, `${name}.firstClassBasisPoints liegt über 10000.`);
    invariant(typeof formation.characteristics.accessible === "boolean", `${name}.accessible fehlt.`);
    integer(formation.characteristics.bicyclePlaces, `${name}.characteristics.bicyclePlaces`);
    integer(formation.characteristics.wheelchairPlaces, `${name}.characteristics.wheelchairPlaces`);
    validStringList(formation.characteristics.equipment, `${name}.characteristics.equipment`, true);
    integer(formation.characteristics.vehicleAgeYears, `${name}.characteristics.vehicleAgeYears`);
    integer(formation.characteristics.maximumSpeedKph, `${name}.characteristics.maximumSpeedKph`, 1);
    integer(formation.characteristics.operatingCostCentsPerTrainKm, `${name}.characteristics.operatingCostCentsPerTrainKm`);
    validStringList(formation.characteristics.homologatedLineIds, `${name}.characteristics.homologatedLineIds`);
    integer(formation.characteristics.maintenanceValidUntil, `${name}.characteristics.maintenanceValidUntil`, 1);
    invariant(["electric", "diesel", "battery", "hydrogen"].includes(formation.characteristics.traction), `${name}.traction ist unbekannt.`);
    invariant(typeof formation.characteristics.replacementPlan === "boolean", `${name}.replacementPlan fehlt.`);
  }
  for (const [index, duty] of snapshot.personnelDuties.entries()) {
    const name = `personnelDuties[${index}]`;
    nonEmpty(duty.operatorId, `${name}.operatorId`);
    validStringList(duty.formationIds, `${name}.formationIds`);
    invariant(["ready", "planned", "uncovered"].includes(duty.status), `${name}.status ist unbekannt.`);
    validWindow(duty.validFrom, duty.validUntil, `${name}.validity`);
  }
  for (const [index, reservation] of snapshot.pathReservations.entries()) {
    const name = `pathReservations[${index}]`;
    nonEmpty(reservation.operatorId, `${name}.operatorId`);
    validStringList(reservation.serviceLineIds, `${name}.serviceLineIds`);
    invariant(["confirmed", "requested", "rejected"].includes(reservation.status), `${name}.status ist unbekannt.`);
    validWindow(reservation.validFrom, reservation.validUntil, `${name}.validity`);
  }
  return snapshot;
}

export function createFleetMobilizationEnvelope(snapshot: FleetMobilizationSnapshot): FleetMobilizationEnvelope {
  validateFleetMobilizationSnapshot(snapshot);
  return Object.freeze({ snapshot, snapshotHash: fleetSnapshotHash(snapshot) });
}

export function validateFleetMobilizationEnvelope(envelope: FleetMobilizationEnvelope): FleetMobilizationEnvelope {
  validateFleetMobilizationSnapshot(envelope.snapshot);
  invariant(/^[a-f0-9]{64}$/.test(envelope.snapshotHash), "snapshotHash ist kein SHA-256.");
  invariant(envelope.snapshotHash === fleetSnapshotHash(envelope.snapshot), "snapshotHash gehört nicht zu den Nutzdaten.");
  return envelope;
}

/** Append-only und monoton: dieselbe Revision ist idempotent, aber niemals überschreibbar. */
export async function persistFleetMobilizationSnapshot(
  db: EconomyDatabase,
  expectedWorldId: string,
  envelope: FleetMobilizationEnvelope,
  ingestedAt: Date,
): Promise<{ readonly created: boolean; readonly snapshotHash: string }> {
  validateFleetMobilizationEnvelope(envelope);
  invariant(envelope.snapshot.worldId === expectedWorldId, "M5-Snapshot verletzt Weltisolation.");
  const [existing] = await db
    .select({ snapshotHash: fleetMobilizationSnapshots.snapshotHash })
    .from(fleetMobilizationSnapshots)
    .where(and(
      eq(fleetMobilizationSnapshots.worldId, expectedWorldId),
      eq(fleetMobilizationSnapshots.revision, envelope.snapshot.revision),
    ))
    .limit(1);
  if (existing !== undefined) {
    invariant(existing.snapshotHash === envelope.snapshotHash, "M5-Revision wurde mit anderen Nutzdaten erneut gesendet.");
    return { created: false, snapshotHash: existing.snapshotHash };
  }
  const [latest] = await db
    .select({ revision: fleetMobilizationSnapshots.revision })
    .from(fleetMobilizationSnapshots)
    .where(eq(fleetMobilizationSnapshots.worldId, expectedWorldId))
    .orderBy(desc(fleetMobilizationSnapshots.revision))
    .limit(1);
  invariant(latest === undefined || envelope.snapshot.revision > latest.revision, "M5-Snapshot-Revision ist nicht monoton.");
  const inserted = await db
    .insert(fleetMobilizationSnapshots)
    .values({
      worldId: expectedWorldId,
      revision: envelope.snapshot.revision,
      snapshotHash: envelope.snapshotHash,
      payload: envelope.snapshot,
      producedAt: new Date(envelope.snapshot.producedAt * 1_000),
      ingestedAt,
    })
    .onConflictDoNothing()
    .returning({ snapshotHash: fleetMobilizationSnapshots.snapshotHash });
  invariant(inserted.length === 1, "M5-Snapshot konnte wegen einer konkurrierenden Revision nicht gespeichert werden.");
  return { created: true, snapshotHash: envelope.snapshotHash };
}

export async function loadFleetMobilizationSnapshot(
  db: EconomyDatabase,
  worldId: string,
  reference: FleetSnapshotReference,
): Promise<FleetMobilizationSnapshot> {
  const [row] = await db
    .select({ payload: fleetMobilizationSnapshots.payload, snapshotHash: fleetMobilizationSnapshots.snapshotHash })
    .from(fleetMobilizationSnapshots)
    .where(and(
      eq(fleetMobilizationSnapshots.worldId, worldId),
      eq(fleetMobilizationSnapshots.revision, reference.fleetRevision),
      eq(fleetMobilizationSnapshots.snapshotHash, reference.snapshotHash),
    ))
    .limit(1);
  invariant(row !== undefined, "Referenzierter M5-Snapshot ist in dieser Welt nicht vorhanden.");
  const snapshot = row.payload as FleetMobilizationSnapshot;
  validateFleetMobilizationSnapshot(snapshot);
  invariant(fleetSnapshotHash(snapshot) === row.snapshotHash, "Persistierter M5-Snapshot ist beschädigt.");
  return snapshot;
}

function snapshotMatches(snapshot: FleetMobilizationSnapshot, reference: FleetSnapshotReference): void {
  invariant(snapshot.revision === reference.fleetRevision, "M5-Revision stimmt nicht überein.");
  invariant(fleetSnapshotHash(snapshot) === reference.snapshotHash, "M5-Snapshot-Hash stimmt nicht überein.");
}

function coversWindow(from: number, until: number, at: number): boolean {
  return from <= at && at < until;
}

function coversAll(actual: readonly string[], required: readonly string[]): boolean {
  const values = new Set(actual);
  return required.every((item) => values.has(item));
}

/** Leitet alle wertungsrelevanten Gebotswerte ausschließlich aus dem M5-Snapshot ab. */
export function resolveVehicleConcept(
  snapshot: FleetMobilizationSnapshot,
  reference: FleetVehicleReference,
  input: { readonly operatorId: string; readonly serviceLineIds: readonly string[]; readonly operatingFrom: number },
): VehicleConcept {
  validateFleetMobilizationSnapshot(snapshot);
  snapshotMatches(snapshot, reference);
  const formation = snapshot.formations.find((candidate) => candidate.id === reference.formationId);
  invariant(formation !== undefined, "Formation fehlt im referenzierten M5-Snapshot.");
  invariant(formation.operatorId === input.operatorId, "Formation gehört einem anderen EVU.");
  invariant(formation.procurement === "delivered", "Formation ist aus der Beschaffung noch nicht geliefert.");
  invariant(formation.availability === "available", "Formation ist nicht frei verfügbar.");
  invariant(coversWindow(formation.availableFrom, formation.availableUntil, input.operatingFrom), "Formation ist am Betriebsstart nicht verfügbar.");
  invariant(coversAll(formation.serviceLineIds, input.serviceLineIds), "Formation ist für die ausgeschriebenen Linien nicht freigegeben.");
  invariant(coversAll(formation.characteristics.homologatedLineIds, input.serviceLineIds), "Formation besitzt keine Zulassung für alle ausgeschriebenen Linien.");
  invariant(formation.characteristics.maintenanceValidUntil >= input.operatingFrom, "Instandhaltungsfreigabe deckt den Betriebsstart nicht ab.");
  return Object.freeze({
    formationId: formation.id,
    minimumSeats: formation.characteristics.seats,
    maximumSpeedKph: formation.characteristics.maximumSpeedKph,
    operatingCostCentsPerTrainKm: formation.characteristics.operatingCostCentsPerTrainKm,
    firstClassBasisPoints: formation.characteristics.firstClassBasisPoints,
    accessible: formation.characteristics.accessible,
    bicyclePlaces: formation.characteristics.bicyclePlaces,
    wheelchairPlaces: formation.characteristics.wheelchairPlaces,
    requiredEquipment: Object.freeze([...formation.characteristics.equipment]),
    vehicleAgeYears: formation.characteristics.vehicleAgeYears,
    traction: formation.characteristics.traction,
    replacementPlan: formation.characteristics.replacementPlan,
    evidence: Object.freeze({
      source: FLEET_MOBILIZATION_SCHEMA,
      fleetRevision: snapshot.revision,
      snapshotHash: reference.snapshotHash,
      formationId: formation.id,
    }),
  });
}

/** Prüft beim Stichtag Formation, Personal und Trasse gegen dieselbe, stabile Revision. */
export function verifyMobilizationReference(
  snapshot: FleetMobilizationSnapshot,
  reference: FleetMobilizationReference,
  input: {
    readonly operatorId: string;
    readonly winningFormationId: string;
    readonly serviceLineIds: readonly string[];
    readonly operatingFrom: number;
  },
): MobilizationProof {
  validateFleetMobilizationSnapshot(snapshot);
  snapshotMatches(snapshot, reference);
  validStringList(reference.formationIds, "formationIds");
  validStringList(reference.personnelDutyIds, "personnelDutyIds");
  validStringList(reference.pathReservationIds, "pathReservationIds");
  invariant(reference.formationIds.includes(input.winningFormationId), "Zugeschlagene Formation fehlt im Mobilisierungsnachweis.");

  const formations = reference.formationIds.map((id) => snapshot.formations.find((formation) => formation.id === id));
  invariant(formations.every((formation) => formation !== undefined), "Mobilisierungsnachweis verweist auf eine unbekannte Formation.");
  for (const formation of formations as FleetFormationSnapshot[]) {
    invariant(formation.operatorId === input.operatorId, "Mobilisierungsformation gehört einem anderen EVU.");
    invariant(formation.procurement === "delivered", "Mobilisierungsformation ist noch nicht geliefert.");
    invariant(["available", "committed"].includes(formation.availability), "Mobilisierungsformation ist technisch nicht verfügbar.");
    invariant(coversWindow(formation.availableFrom, formation.availableUntil, input.operatingFrom), "Mobilisierungsformation deckt den Stichtag nicht ab.");
    invariant(coversAll(formation.serviceLineIds, input.serviceLineIds), "Mobilisierungsformation ist für das Los ungeeignet.");
    invariant(coversAll(formation.characteristics.homologatedLineIds, input.serviceLineIds), "Mobilisierungsformation ist für das Los nicht zugelassen.");
    invariant(formation.characteristics.maintenanceValidUntil >= input.operatingFrom, "Instandhaltungsfreigabe der Formation ist am Stichtag abgelaufen.");
  }

  const duties = reference.personnelDutyIds.map((id) => snapshot.personnelDuties.find((duty) => duty.id === id));
  invariant(duties.every((duty) => duty !== undefined), "Mobilisierungsnachweis verweist auf einen unbekannten Personaldienst.");
  invariant(
    (duties as FleetPersonnelDutySnapshot[]).every((duty) =>
      duty.operatorId === input.operatorId &&
      duty.status === "ready" &&
      coversWindow(duty.validFrom, duty.validUntil, input.operatingFrom)),
    "Personal ist für EVU und Stichtag nicht vollständig einsatzbereit.",
  );
  const coveredFormationIds = new Set((duties as FleetPersonnelDutySnapshot[]).flatMap((duty) => duty.formationIds));
  invariant(reference.formationIds.every((id) => coveredFormationIds.has(id)), "Nicht jede Formation ist durch einen Personaldienst gedeckt.");

  const reservations = reference.pathReservationIds.map((id) => snapshot.pathReservations.find((reservation) => reservation.id === id));
  invariant(reservations.every((reservation) => reservation !== undefined), "Mobilisierungsnachweis verweist auf eine unbekannte Trassenreservierung.");
  invariant(
    (reservations as FleetPathReservationSnapshot[]).every((reservation) =>
      reservation.operatorId === input.operatorId &&
      reservation.status === "confirmed" &&
      coversWindow(reservation.validFrom, reservation.validUntil, input.operatingFrom)),
    "Trassenreservierung ist für EVU und Stichtag nicht bestätigt.",
  );
  const coveredLines = new Set((reservations as FleetPathReservationSnapshot[]).flatMap((reservation) => reservation.serviceLineIds));
  invariant(input.serviceLineIds.every((line) => coveredLines.has(line)), "Nicht jede ausgeschriebene Linie besitzt eine bestätigte Trasse.");

  return Object.freeze({
    source: "m5-release",
    verifiedBy: FLEET_MOBILIZATION_SCHEMA,
    fleetRevision: reference.fleetRevision,
    snapshotHash: reference.snapshotHash,
    formationIds: Object.freeze([...reference.formationIds]),
    personnelDutyIds: Object.freeze([...reference.personnelDutyIds]),
    pathReservationIds: Object.freeze([...reference.pathReservationIds]),
  });
}
