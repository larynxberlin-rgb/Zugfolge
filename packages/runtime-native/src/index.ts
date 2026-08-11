import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

export * from "./regional-simulation.js";

export const OPERATING_INITIALIZE_SCHEMA = "zugfolge-operating-world-initialize/v1" as const;
export const OPERATING_STATE_SCHEMA = "zugfolge-operating-world-state/v1" as const;
export const OPERATING_TRANSITION_SCHEMA = "zugfolge-operating-transition-command/v1" as const;
export const OPERATING_RESULT_SCHEMA = "zugfolge-operating-transition-result/v1" as const;
export const FLEET_MOBILIZATION_VERIFICATION_SCHEMA = "zugfolge-fleet-mobilization-verification/v1" as const;
export const FLEET_INITIALIZE_SCHEMA = "zugfolge-fleet-world-initialize/v2" as const;
export const FLEET_INITIALIZED_SCHEMA = "zugfolge-fleet-world-initialized/v2" as const;
export const FLEET_STATE_SCHEMA = "zugfolge-fleet-world-state/v2" as const;
export const FLEET_AUTHORITY_RELEASE_SCHEMA = "zugfolge-fleet-authority-release/v1" as const;
export const FLEET_FORMATION_COMMAND_SCHEMA = "zugfolge-fleet-form-vehicles-command/v2" as const;
export const FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA = "zugfolge-fleet-assign-duty-command/v2" as const;
export const FLEET_PATH_RESERVATION_COMMAND_SCHEMA = "zugfolge-fleet-attach-path-command/v2" as const;
export const FLEET_COMMAND_RESULT_SCHEMA = "zugfolge-fleet-command-result/v2" as const;
export const FLEET_COMMAND_RECEIPT_SCHEMA = "zugfolge-fleet-command-receipt/v1" as const;

export interface FleetMobilizationVerification {
  readonly schemaVersion: typeof FLEET_MOBILIZATION_VERIFICATION_SCHEMA;
  readonly worldId: string;
  readonly fleetRevision: number;
  readonly snapshotHash: string;
}

export interface NativeFleetCharacteristics {
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
}

export interface NativeFleetFormation {
  readonly id: string;
  readonly operatorId: string;
  readonly vehicleIds: readonly string[];
  readonly serviceLineIds: readonly string[];
  readonly availability: "available" | "committed" | "maintenance" | "retired";
  readonly procurement: "delivered" | "ordered" | "cancelled";
  readonly availableFrom: number;
  readonly availableUntil: number;
  readonly characteristics: NativeFleetCharacteristics;
}

export interface NativeFleetPersonnelDuty {
  readonly id: string;
  readonly operatorId: string;
  readonly formationIds: readonly string[];
  readonly status: "ready" | "planned" | "uncovered";
  readonly validFrom: number;
  readonly validUntil: number;
}

export interface NativeFleetPathReservation {
  readonly id: string;
  readonly operatorId: string;
  readonly serviceLineIds: readonly string[];
  readonly status: "confirmed" | "requested" | "rejected";
  readonly validFrom: number;
  readonly validUntil: number;
}

export interface NativeFleetMobilizationSnapshot {
  readonly schema: "zugfolge-fleet-mobilization/v1";
  readonly worldId: string;
  readonly revision: number;
  readonly producedAt: number;
  readonly formations: readonly NativeFleetFormation[];
  readonly personnelDuties: readonly NativeFleetPersonnelDuty[];
  readonly pathReservations: readonly NativeFleetPathReservation[];
}

export interface FleetAuthorityMaintenanceDeadline {
  readonly kind: string;
  readonly dueAt: number;
}

export interface FleetAuthorityTechnicalData {
  readonly lengthMm: number;
  readonly massKg: number;
  readonly maximumSpeedKph: number;
  readonly accelerationMmPerS2: number;
  readonly decelerationMmPerS2: number;
  readonly traction: "electric" | "diesel" | "battery";
  readonly electricSystems: readonly ("ac15kv" | "ac25kv" | "dc750v" | "dc1500v" | "dc3000v")[];
}

export interface FleetAuthorityPassengerData {
  readonly seats: number;
  readonly firstClassSeats: number;
  readonly accessible: boolean;
  readonly bicyclePlaces: number;
  readonly wheelchairPlaces: number;
  readonly equipment: readonly string[];
  readonly operatingCostCentsPerTrainKm: number;
  readonly replacementPlan: boolean;
}

export interface FleetAuthorityVehicleAsset {
  readonly id: string;
  readonly numericId: number;
  readonly operatorId: string;
  readonly vehicleTypeId: number;
  readonly classDesignation: string;
  readonly tradeName: string;
  readonly buildYear: number;
  readonly acquisitionYear: number;
  readonly procurementChannel: "new-build" | "leasing" | "used";
  readonly approvedLineIds: readonly string[];
  readonly maintenanceDeadlines: readonly FleetAuthorityMaintenanceDeadline[];
  readonly installedProtection: readonly ("pzb" | "lzb" | "etcs-level1" | "etcs-level2")[];
  readonly technical: FleetAuthorityTechnicalData;
  readonly passenger: FleetAuthorityPassengerData;
  readonly deliveredAt: number;
  readonly retiredAt: number;
}

export interface FleetAuthorityPersonnelPool {
  readonly id: string;
  readonly numericId: number;
  readonly operatorId: string;
  readonly capacitySeconds: number;
  readonly minimumRestSeconds: number;
  readonly classDesignations: readonly string[];
  readonly pathReceiptIds: readonly string[];
  readonly qualificationHash: string;
}

export interface FleetAuthorityPathReceipt {
  readonly id: string;
  readonly numericRouteId: number;
  readonly operatorId: string;
  readonly serviceLineIds: readonly string[];
  readonly decision: "confirmed" | "requested" | "rejected";
  readonly validFrom: number;
  readonly validUntil: number;
  readonly platformLengthsMm: readonly number[];
  readonly electrifications: readonly (
    | "unelectrified"
    | "overhead-ac15kv"
    | "overhead-ac25kv"
    | "overhead-dc1500v"
    | "overhead-dc3000v"
  )[];
  readonly requiredProtection: readonly ("pzb" | "lzb" | "etcs-level1" | "etcs-level2")[];
  readonly approvedClasses: readonly string[];
  readonly plannerStateHash: string;
  readonly conflictCheckHash: string;
}

/** Serververtrauenswuerdige, fuer eine Welt eingefrorene M5-Quellfakten. */
export interface FleetAuthorityRelease {
  readonly schemaVersion: typeof FLEET_AUTHORITY_RELEASE_SCHEMA;
  readonly releaseId: string;
  readonly referenceYear: number;
  readonly assets: readonly FleetAuthorityVehicleAsset[];
  readonly personnelPools: readonly FleetAuthorityPersonnelPool[];
  readonly pathReceipts: readonly FleetAuthorityPathReceipt[];
}

export interface FleetWorldInitialization {
  readonly schemaVersion: typeof FLEET_INITIALIZE_SCHEMA;
  readonly worldId: string;
  readonly producedAt: number;
  readonly authorityRelease: FleetAuthorityRelease;
}

export interface NativeFleetFormationIntent {
  readonly id: string;
  readonly vehicleIds: readonly string[];
  readonly pathReceiptId: string;
}

export interface NativeFleetPersonnelDutyIntent {
  readonly id: string;
  readonly personnelPoolId: string;
  readonly formationIds: readonly string[];
  readonly pathReceiptId: string;
  readonly validFrom: number;
  readonly validUntil: number;
}

export interface NativeFleetPathReservationIntent {
  readonly id: string;
  readonly pathReceiptId: string;
}

export type NativeFleetWorldState = Readonly<Record<string, unknown>> & {
  readonly schemaVersion: typeof FLEET_STATE_SCHEMA;
  readonly worldId: string;
  readonly revision: number;
  readonly producedAt: number;
  readonly authorityReleaseHash: string;
  readonly authorityRelease: FleetAuthorityRelease;
  readonly formations: Readonly<Record<string, NativeFleetFormationIntent>>;
  readonly personnelDuties: Readonly<Record<string, NativeFleetPersonnelDutyIntent>>;
  readonly pathReservations: Readonly<Record<string, NativeFleetPathReservationIntent>>;
};

interface FleetCommandBase {
  readonly worldId: string;
  readonly commandId: string;
  readonly expectedStateHash: string;
  readonly expectedRevision: number;
  readonly atS: number;
}

export type NativeFleetCommand =
  | FleetCommandBase & {
      readonly schemaVersion: typeof FLEET_FORMATION_COMMAND_SCHEMA;
      readonly formationId: string;
      readonly vehicleIds: readonly string[];
      readonly pathReceiptId: string;
    }
  | FleetCommandBase & {
      readonly schemaVersion: typeof FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA;
      readonly personnelDutyId: string;
      readonly personnelPoolId: string;
      readonly formationIds: readonly string[];
      readonly pathReceiptId: string;
      readonly validFrom: number;
      readonly validUntil: number;
    }
  | FleetCommandBase & {
      readonly schemaVersion: typeof FLEET_PATH_RESERVATION_COMMAND_SCHEMA;
      readonly pathReservationId: string;
      readonly pathReceiptId: string;
    };

export interface FleetCommandReceipt {
  readonly schemaVersion: typeof FLEET_COMMAND_RECEIPT_SCHEMA;
  readonly worldId: string;
  readonly commandId: string;
  readonly commandHash: string;
  readonly canonicalCommandJson: string;
  readonly resultingRevision: number;
  readonly entityKind: "formation" | "personnel-duty" | "path-reservation";
  readonly entityId: string;
  readonly resultingStateHash: string;
  readonly resultingSnapshotHash: string;
}

export interface FleetWorldInitialized {
  readonly schemaVersion: typeof FLEET_INITIALIZED_SCHEMA;
  readonly state: NativeFleetWorldState;
  readonly stateHash: string;
  readonly snapshot: NativeFleetMobilizationSnapshot;
  readonly snapshotHash: string;
}

export interface FleetCommandResult {
  readonly schemaVersion: typeof FLEET_COMMAND_RESULT_SCHEMA;
  readonly state: NativeFleetWorldState;
  readonly stateHash: string;
  readonly snapshot: NativeFleetMobilizationSnapshot;
  readonly snapshotHash: string;
  readonly commandReceipt: FleetCommandReceipt;
  readonly appliedCommandId: string;
  readonly entityKind: "formation" | "personnel-duty" | "path-reservation";
  readonly entityId: string;
  readonly idempotentReplay: boolean;
}

export interface OperatingTrainRunInitialization {
  readonly trainRunId: string;
  readonly formationId?: string | null;
}

export interface OperatingWorldInitialization {
  readonly schemaVersion: typeof OPERATING_INITIALIZE_SCHEMA;
  readonly worldId: string;
  readonly lots: readonly {
    readonly lotId: string;
    readonly incumbentOperatorId: string;
    readonly timetableBoundaryS: number;
    readonly trainRuns: readonly OperatingTrainRunInitialization[];
  }[];
}

export interface OperatingMobilizationProof {
  readonly source: "m5-release";
  readonly verifiedBy: "zugfolge-fleet-mobilization/v1";
  readonly fleetRevision: number;
  readonly snapshotHash: string;
  readonly formationIds: readonly string[];
  readonly personnelDutyIds: readonly string[];
  readonly pathReservationIds: readonly string[];
}

export interface OperatingTransitionCommand {
  readonly schemaVersion: typeof OPERATING_TRANSITION_SCHEMA;
  readonly worldId: string;
  readonly commandId: string;
  readonly expectedStateHash: string;
  readonly expectedRevision: number;
  readonly lotId: string;
  readonly atS: number;
  readonly winnerOperatorId: string;
  readonly mobilizationProof: OperatingMobilizationProof | null;
  readonly publicVehiclePool: readonly string[];
}

export interface OperatingRuntimeEvent {
  readonly eventId: string;
  readonly worldId: string;
  readonly eventType: string;
  readonly atS: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OperatingTransitionOutcome {
  readonly lotId: string;
  readonly previousOperatorId: string;
  readonly operatorId: string;
  readonly kind: "seamless-continuation" | "operator-change" | "public-operation";
  readonly seamless: boolean;
  readonly penaltyRequired: boolean;
  readonly trainRunIds: readonly string[];
  readonly livemapMarker: "public-operator" | null;
}

export interface OperatingWorldInitialized {
  readonly schemaVersion: "zugfolge-operating-world-initialized/v1";
  readonly state: Readonly<Record<string, unknown>> & {
    readonly schemaVersion: typeof OPERATING_STATE_SCHEMA;
    readonly worldId: string;
    readonly revision: number;
  };
  readonly stateHash: string;
}

export interface OperatingTransitionResult {
  readonly schemaVersion: typeof OPERATING_RESULT_SCHEMA;
  readonly state: OperatingWorldInitialized["state"];
  readonly stateHash: string;
  readonly outcome: OperatingTransitionOutcome;
  readonly events: readonly OperatingRuntimeEvent[];
  readonly idempotentReplay: boolean;
}

export interface FleetRuntime {
  readonly initializeFleet: (input: FleetWorldInitialization) => FleetWorldInitialized;
  readonly applyFleetCommand: (
    state: NativeFleetWorldState,
    command: NativeFleetCommand,
    replayReceipt?: FleetCommandReceipt,
  ) => FleetCommandResult;
}

export interface OperatingRuntime {
  /** @deprecated Productive M5 producers use commands and never submit snapshots. */
  readonly verifyFleetMobilizationSnapshot: (snapshot: unknown) => FleetMobilizationVerification;
  readonly initialize: (input: OperatingWorldInitialization) => OperatingWorldInitialized;
  readonly applyTransition: (
    state: OperatingWorldInitialized["state"],
    command: OperatingTransitionCommand,
  ) => OperatingTransitionResult;
}

export type NativeRuntime = FleetRuntime & OperatingRuntime;

interface NativeAddon {
  readonly initializeFleetWorld: (inputJson: string) => string;
  readonly applyFleetCommand: (stateJson: string, commandJson: string, replayReceiptJson?: string) => string;
  readonly verifyFleetMobilizationSnapshot: (inputJson: string) => string;
  readonly initializeOperatingWorld: (inputJson: string) => string;
  readonly applyOperatingTransition: (stateJson: string, commandJson: string) => string;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseNativeJson(json: string, name: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`${name} ist kein JSON: ${json}`, { cause: error });
  }
}

function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value), `${name} ist kein Objekt.`);
}

function sha256(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), `${name} ist kein SHA-256.`);
}

function safeInteger(value: unknown, name: string): asserts value is number {
  invariant(Number.isSafeInteger(value) && (value as number) >= 0, `${name} ist keine nichtnegative sichere Ganzzahl.`);
}

function nonEmptyString(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string" && value.trim().length > 0, `${name} ist keine nichtleere Zeichenkette.`);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalStringSet(value: unknown, name: string): readonly string[] {
  invariant(Array.isArray(value) && value.length > 0, `${name} ist keine nichtleere Kennungsmenge.`);
  const sorted = value.map((item, index) => {
    nonEmptyString(item, `${name}[${index}]`);
    return item;
  }).sort(compareUtf8);
  invariant(
    sorted.every((item, index) => index === 0 || compareUtf8(sorted[index - 1]!, item) < 0),
    `${name} enthaelt doppelte Kennungen.`,
  );
  return sorted;
}

function exactFleetCommandFields(command: Record<string, unknown>, specificFields: readonly string[]): void {
  const allowed = new Set([
    "schemaVersion",
    "worldId",
    "commandId",
    "expectedStateHash",
    "expectedRevision",
    "atS",
    ...specificFields,
  ]);
  const ownKeys = Reflect.ownKeys(command);
  invariant(
    ownKeys.length === allowed.size
      && ownKeys.every((key) => typeof key === "string" && allowed.has(key))
      && Object.keys(command).length === allowed.size,
    "M5-Kommando enthaelt alte, unbekannte oder fehlende Intent-Felder.",
  );
}

function commonFleetCommand(command: Record<string, unknown>): void {
  nonEmptyString(command["worldId"], "M5-Kommando-Welt");
  nonEmptyString(command["commandId"], "M5-Kommando-ID");
  sha256(command["expectedStateHash"], "M5-Kommando-Zustandshash");
  safeInteger(command["expectedRevision"], "M5-Kommando-Revision");
  safeInteger(command["atS"], "M5-Kommando-Zeit");
}

function normalizeFleetCommand(command: NativeFleetCommand): NativeFleetCommand {
  record(command, "M5-Kommando");
  commonFleetCommand(command);
  switch (command.schemaVersion) {
    case FLEET_FORMATION_COMMAND_SCHEMA: {
      exactFleetCommandFields(command, ["formationId", "vehicleIds", "pathReceiptId"]);
      nonEmptyString(command.formationId, "M5-Formation-ID");
      nonEmptyString(command.pathReceiptId, "M5-Trassenbeleg-ID");
      return {
        schemaVersion: command.schemaVersion,
        worldId: command.worldId,
        commandId: command.commandId,
        expectedStateHash: command.expectedStateHash,
        expectedRevision: command.expectedRevision,
        atS: command.atS,
        formationId: command.formationId,
        vehicleIds: canonicalStringSet(command.vehicleIds, "M5-Fahrzeug-IDs"),
        pathReceiptId: command.pathReceiptId,
      };
    }
    case FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA: {
      exactFleetCommandFields(command, [
        "personnelDutyId",
        "personnelPoolId",
        "formationIds",
        "pathReceiptId",
        "validFrom",
        "validUntil",
      ]);
      nonEmptyString(command.personnelDutyId, "M5-Personaldienst-ID");
      nonEmptyString(command.personnelPoolId, "M5-Personalpool-ID");
      nonEmptyString(command.pathReceiptId, "M5-Trassenbeleg-ID");
      safeInteger(command.validFrom, "M5-Personaldienst-Beginn");
      safeInteger(command.validUntil, "M5-Personaldienst-Ende");
      return {
        schemaVersion: command.schemaVersion,
        worldId: command.worldId,
        commandId: command.commandId,
        expectedStateHash: command.expectedStateHash,
        expectedRevision: command.expectedRevision,
        atS: command.atS,
        personnelDutyId: command.personnelDutyId,
        personnelPoolId: command.personnelPoolId,
        formationIds: canonicalStringSet(command.formationIds, "M5-Formation-IDs"),
        pathReceiptId: command.pathReceiptId,
        validFrom: command.validFrom,
        validUntil: command.validUntil,
      };
    }
    case FLEET_PATH_RESERVATION_COMMAND_SCHEMA:
      exactFleetCommandFields(command, ["pathReservationId", "pathReceiptId"]);
      nonEmptyString(command.pathReservationId, "M5-Trassenreservierungs-ID");
      nonEmptyString(command.pathReceiptId, "M5-Trassenbeleg-ID");
      return {
        schemaVersion: command.schemaVersion,
        worldId: command.worldId,
        commandId: command.commandId,
        expectedStateHash: command.expectedStateHash,
        expectedRevision: command.expectedRevision,
        atS: command.atS,
        pathReservationId: command.pathReservationId,
        pathReceiptId: command.pathReceiptId,
      };
    default:
      throw new Error("M5-Kommando hat ein unbekanntes Schema.");
  }
}

function canonicalJson(value: unknown, name: string, ancestors = new Set<object>()): string {
  if (Array.isArray(value)) {
    invariant(!ancestors.has(value), `${name} enthaelt einen JSON-Zyklus.`);
    ancestors.add(value);
    try {
      return `[${Array.from(value, (item, index) => canonicalJson(item, `${name}[${index}]`, ancestors)).join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (value !== null && typeof value === "object") {
    invariant(!ancestors.has(value), `${name} enthaelt einen JSON-Zyklus.`);
    invariant(
      Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
      `${name} enthaelt kein reines JSON-Objekt.`,
    );
    invariant(Object.getOwnPropertySymbols(value).length === 0, `${name} enthaelt Symbolschluessel.`);
    ancestors.add(value);
    try {
      const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareUtf8(left, right));
      return `{${entries.map(([key, item]) => {
        invariant(item !== undefined, `${name}.${key} ist undefined.`);
        return `${JSON.stringify(key)}:${canonicalJson(item, `${name}.${key}`, ancestors)}`;
      }).join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  invariant(
    value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number",
    `${name} enthaelt einen nicht unterstuetzten JSON-Wert.`,
  );
  if (typeof value === "number") {
    invariant(Number.isSafeInteger(value), `${name} enthaelt keine sichere Ganzzahl.`);
  }
  return JSON.stringify(value);
}

/** Normalisiert mengenartige IDs und erzeugt ein von der Eingabereihenfolge unabhaengiges Kommando. */
export function canonicalizeFleetCommand(command: NativeFleetCommand): NativeFleetCommand {
  return JSON.parse(canonicalJson(normalizeFleetCommand(command), "M5-Kommando")) as NativeFleetCommand;
}

/** Entspricht bytegenau der rekursiv schluesselsortierten Rust-Kanonform. */
export function canonicalFleetCommandJson(command: NativeFleetCommand): string {
  return canonicalJson(normalizeFleetCommand(command), "M5-Kommando");
}

/** SHA-256 der persistierbaren, kanonischen M5-Kommandodarstellung. */
export function canonicalFleetCommandHash(command: NativeFleetCommand): string {
  return createHash("sha256").update(canonicalFleetCommandJson(command), "utf8").digest("hex");
}

export function fleetCommandEntity(command: NativeFleetCommand): {
  readonly entityKind: FleetCommandResult["entityKind"];
  readonly entityId: string;
} {
  switch (command.schemaVersion) {
    case FLEET_FORMATION_COMMAND_SCHEMA:
      return { entityKind: "formation", entityId: command.formationId };
    case FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA:
      return { entityKind: "personnel-duty", entityId: command.personnelDutyId };
    case FLEET_PATH_RESERVATION_COMMAND_SCHEMA:
      return { entityKind: "path-reservation", entityId: command.pathReservationId };
  }
}

function fleetAuthorityRelease(value: unknown, name: string): asserts value is FleetAuthorityRelease {
  record(value, name);
  invariant(value["schemaVersion"] === FLEET_AUTHORITY_RELEASE_SCHEMA, `${name} hat ein unbekanntes Schema.`);
  nonEmptyString(value["releaseId"], `${name}-ID`);
  safeInteger(value["referenceYear"], `${name}-Referenzjahr`);
  invariant(Array.isArray(value["assets"]) && value["assets"].length > 0, `${name} besitzt keine Assets.`);
  invariant(Array.isArray(value["personnelPools"]), `${name} besitzt keine Personalpools.`);
  invariant(Array.isArray(value["pathReceipts"]), `${name} besitzt keine Trassenbelege.`);
  for (const [index, rawPool] of value["personnelPools"].entries()) {
    record(rawPool, `${name}-Personalpool ${index}`);
    sha256(rawPool["qualificationHash"], `${name}-Personalpool-Qualifikationshash`);
  }
  for (const [index, rawReceipt] of value["pathReceipts"].entries()) {
    record(rawReceipt, `${name}-Trassenbeleg ${index}`);
    sha256(rawReceipt["plannerStateHash"], `${name}-Planerzustandshash`);
    sha256(rawReceipt["conflictCheckHash"], `${name}-Konfliktpruefungshash`);
  }
}

function fleetStateIntents(state: Record<string, unknown>, name: string): void {
  record(state["formations"], `${name}-Formationen`);
  for (const [id, rawIntent] of Object.entries(state["formations"])) {
    record(rawIntent, `${name}-Formation '${id}'`);
    invariant(rawIntent["id"] === id, `${name}-Formation besitzt eine fremde ID.`);
    canonicalStringSet(rawIntent["vehicleIds"], `${name}-Formation-Fahrzeuge`);
    nonEmptyString(rawIntent["pathReceiptId"], `${name}-Formation-Trassenbeleg`);
  }
  record(state["personnelDuties"], `${name}-Personaldienste`);
  for (const [id, rawIntent] of Object.entries(state["personnelDuties"])) {
    record(rawIntent, `${name}-Personaldienst '${id}'`);
    invariant(rawIntent["id"] === id, `${name}-Personaldienst besitzt eine fremde ID.`);
    nonEmptyString(rawIntent["personnelPoolId"], `${name}-Personalpool`);
    canonicalStringSet(rawIntent["formationIds"], `${name}-Personaldienst-Formationen`);
    nonEmptyString(rawIntent["pathReceiptId"], `${name}-Personaldienst-Trassenbeleg`);
    safeInteger(rawIntent["validFrom"], `${name}-Personaldienst-Beginn`);
    safeInteger(rawIntent["validUntil"], `${name}-Personaldienst-Ende`);
  }
  record(state["pathReservations"], `${name}-Trassenreservierungen`);
  for (const [id, rawIntent] of Object.entries(state["pathReservations"])) {
    record(rawIntent, `${name}-Trassenreservierung '${id}'`);
    invariant(rawIntent["id"] === id, `${name}-Trassenreservierung besitzt eine fremde ID.`);
    nonEmptyString(rawIntent["pathReceiptId"], `${name}-Trassenreservierungsbeleg`);
  }
}

function fleetReceipt(value: unknown, name: string): asserts value is FleetCommandReceipt {
  record(value, name);
  const receiptFields = new Set([
    "schemaVersion",
    "worldId",
    "commandId",
    "commandHash",
    "canonicalCommandJson",
    "resultingRevision",
    "entityKind",
    "entityId",
    "resultingStateHash",
    "resultingSnapshotHash",
  ]);
  invariant(
    Reflect.ownKeys(value).length === receiptFields.size
      && Reflect.ownKeys(value).every((key) => typeof key === "string" && receiptFields.has(key))
      && Object.keys(value).length === receiptFields.size,
    `${name} ist nicht kompakt oder unvollstaendig.`,
  );
  invariant(value["schemaVersion"] === FLEET_COMMAND_RECEIPT_SCHEMA, `${name} hat ein unbekanntes Schema.`);
  nonEmptyString(value["worldId"], `${name}-Welt`);
  nonEmptyString(value["commandId"], `${name}-Kommando-ID`);
  sha256(value["commandHash"], `${name}-Kommandohash`);
  nonEmptyString(value["canonicalCommandJson"], `${name}-Kanonform`);
  const canonicalCommand: unknown = parseNativeJson(value["canonicalCommandJson"], `${name}-Kanonform`);
  invariant(
    canonicalJson(canonicalCommand, `${name}-Kanonform`) === value["canonicalCommandJson"],
    `${name}-Kommando ist nicht kanonisch serialisiert.`,
  );
  invariant(
    createHash("sha256").update(value["canonicalCommandJson"], "utf8").digest("hex") === value["commandHash"],
    `${name}-Kommandohash bindet nicht die Kanonform.`,
  );
  safeInteger(value["resultingRevision"], `${name}-Revision`);
  invariant((value["resultingRevision"] as number) > 0, `${name}-Revision ist nicht positiv.`);
  invariant(
    ["formation", "personnel-duty", "path-reservation"].includes(value["entityKind"] as string),
    `${name} hat eine unbekannte Entitaetsart.`,
  );
  nonEmptyString(value["entityId"], `${name}-Entitaets-ID`);
  sha256(value["resultingStateHash"], `${name}-Zustandshash`);
  sha256(value["resultingSnapshotHash"], `${name}-Snapshothash`);
}

function fleetPayload(
  value: Record<string, unknown>,
  name: string,
): asserts value is Record<string, unknown> & {
  state: NativeFleetWorldState;
  stateHash: string;
  snapshot: NativeFleetMobilizationSnapshot;
  snapshotHash: string;
} {
  record(value["state"], `${name}-Zustand`);
  invariant(value["state"]["schemaVersion"] === FLEET_STATE_SCHEMA, `${name}-Zustand hat ein unbekanntes Schema.`);
  invariant(typeof value["state"]["worldId"] === "string" && value["state"]["worldId"].length > 0, `${name}-Zustand hat keine Welt.`);
  safeInteger(value["state"]["revision"], `${name}-Zustandsrevision`);
  safeInteger(value["state"]["producedAt"], `${name}-Zustandszeit`);
  sha256(value["state"]["authorityReleaseHash"], `${name}-Authority-Release-Hash`);
  fleetAuthorityRelease(value["state"]["authorityRelease"], `${name}-Authority-Release`);
  fleetStateIntents(value["state"], `${name}-Zustand`);
  invariant(!Object.hasOwn(value["state"], "processedCommands"), `${name}-Zustand enthaelt ein unbeschraenktes Kommandolog.`);
  sha256(value["stateHash"], `${name}-Zustandshash`);
  record(value["snapshot"], `${name}-Snapshot`);
  invariant(value["snapshot"]["schema"] === "zugfolge-fleet-mobilization/v1", `${name}-Snapshot hat ein unbekanntes Schema.`);
  invariant(value["snapshot"]["worldId"] === value["state"]["worldId"], `${name}-Snapshot verletzt Weltisolation.`);
  invariant(value["snapshot"]["revision"] === value["state"]["revision"], `${name}-Snapshot besitzt eine fremde Revision.`);
  invariant(value["snapshot"]["producedAt"] === value["state"]["producedAt"], `${name}-Snapshot besitzt eine fremde Zustandszeit.`);
  invariant(Array.isArray(value["snapshot"]["formations"]), `${name}-Snapshot besitzt keine Formationen.`);
  invariant(Array.isArray(value["snapshot"]["personnelDuties"]), `${name}-Snapshot besitzt keine Personaldienste.`);
  invariant(Array.isArray(value["snapshot"]["pathReservations"]), `${name}-Snapshot besitzt keine Trassenreservierungen.`);
  sha256(value["snapshotHash"], `${name}-Snapshothash`);
}

function decodeFleetInitialized(json: string): FleetWorldInitialized {
  const value: unknown = parseNativeJson(json, "Rust-M5-Initialisierung");
  record(value, "Rust-M5-Initialisierung");
  invariant(value["schemaVersion"] === FLEET_INITIALIZED_SCHEMA, "Rust-M5-Initialisierung hat ein unbekanntes Schema.");
  fleetPayload(value, "Rust-M5-Initialisierung");
  return value as unknown as FleetWorldInitialized;
}

function decodeFleetCommandResult(json: string): FleetCommandResult {
  const value: unknown = parseNativeJson(json, "Rust-M5-Kommandoergebnis");
  record(value, "Rust-M5-Kommandoergebnis");
  invariant(value["schemaVersion"] === FLEET_COMMAND_RESULT_SCHEMA, "Rust-M5-Kommandoergebnis hat ein unbekanntes Schema.");
  fleetPayload(value, "Rust-M5-Kommandoergebnis");
  fleetReceipt(value["commandReceipt"], "Rust-M5-Command-Receipt");
  invariant(typeof value["appliedCommandId"] === "string" && value["appliedCommandId"].length > 0, "Rust-M5-Kommandoergebnis hat keine Kommando-ID.");
  invariant(["formation", "personnel-duty", "path-reservation"].includes(value["entityKind"] as string), "Rust-M5-Kommandoergebnis hat eine unbekannte Entitaetsart.");
  invariant(typeof value["entityId"] === "string" && value["entityId"].length > 0, "Rust-M5-Kommandoergebnis hat keine Entitaets-ID.");
  invariant(typeof value["idempotentReplay"] === "boolean", "Rust-M5-Kommandoergebnis hat keine Replay-Aussage.");
  return value as unknown as FleetCommandResult;
}

function decodeInitialized(json: string): OperatingWorldInitialized {
  const value: unknown = parseNativeJson(json, "Rust-Initialisierung");
  record(value, "Rust-Initialisierung");
  invariant(value["schemaVersion"] === "zugfolge-operating-world-initialized/v1", "Rust-Initialisierung hat ein unbekanntes Schema.");
  record(value["state"], "Rust-Zustand");
  invariant(value["state"]["schemaVersion"] === OPERATING_STATE_SCHEMA, "Rust-Zustand hat ein unbekanntes Schema.");
  invariant(typeof value["state"]["worldId"] === "string" && value["state"]["worldId"].length > 0, "Rust-Zustand hat keine Welt.");
  safeInteger(value["state"]["revision"], "Rust-Zustandsrevision");
  sha256(value["stateHash"], "Rust-Zustandshash");
  return value as unknown as OperatingWorldInitialized;
}

function decodeFleetVerification(json: string): FleetMobilizationVerification {
  const value: unknown = parseNativeJson(json, "Rust-M5-Verifikation");
  record(value, "Rust-M5-Verifikation");
  invariant(
    value["schemaVersion"] === FLEET_MOBILIZATION_VERIFICATION_SCHEMA,
    "Rust-M5-Verifikation hat ein unbekanntes Schema.",
  );
  invariant(typeof value["worldId"] === "string" && value["worldId"].length > 0, "Rust-M5-Verifikation hat keine Welt.");
  safeInteger(value["fleetRevision"], "Rust-M5-Revision");
  sha256(value["snapshotHash"], "Rust-M5-Snapshothash");
  return value as unknown as FleetMobilizationVerification;
}

function decodeTransition(json: string): OperatingTransitionResult {
  const value: unknown = parseNativeJson(json, "Rust-Uebergang");
  record(value, "Rust-Uebergang");
  invariant(value["schemaVersion"] === OPERATING_RESULT_SCHEMA, "Rust-Uebergang hat ein unbekanntes Schema.");
  record(value["state"], "Rust-Zustand");
  invariant(value["state"]["schemaVersion"] === OPERATING_STATE_SCHEMA, "Rust-Zustand hat ein unbekanntes Schema.");
  safeInteger(value["state"]["revision"], "Rust-Zustandsrevision");
  sha256(value["stateHash"], "Rust-Zustandshash");
  record(value["outcome"], "Rust-Uebergangsergebnis");
  invariant(Array.isArray(value["events"]), "Rust-Uebergang enthaelt keine Ereignisse.");
  invariant(typeof value["idempotentReplay"] === "boolean", "Rust-Uebergang enthaelt keine Replay-Aussage.");
  return value as unknown as OperatingTransitionResult;
}

/** Wraps the native ABI. Exported for contract tests; production uses {@link loadOperatingRuntime}. */
export function operatingRuntimeFromAddon(addon: NativeAddon): NativeRuntime {
  return Object.freeze({
    initializeFleet(input: FleetWorldInitialization) {
      invariant(input.schemaVersion === FLEET_INITIALIZE_SCHEMA, "M5-Initialisierung hat ein unbekanntes Schema.");
      nonEmptyString(input.worldId, "M5-Initialisierungswelt");
      safeInteger(input.producedAt, "M5-Initialisierungszeit");
      fleetAuthorityRelease(input.authorityRelease, "M5-Authority-Release");
      const initialized = decodeFleetInitialized(addon.initializeFleetWorld(JSON.stringify(input)));
      invariant(initialized.state.worldId === input.worldId, "Rust-M5-Initialisierung verletzte die Weltisolation.");
      invariant(initialized.state.revision === 0, "Rust-M5-Initialisierung begann nicht bei Revision 0.");
      invariant(initialized.state.producedAt === input.producedAt, "Rust-M5-Initialisierung veraenderte die Zustandszeit.");
      return initialized;
    },
    applyFleetCommand(state: NativeFleetWorldState, command: NativeFleetCommand, replayReceipt?: FleetCommandReceipt) {
      const canonicalCommand = canonicalizeFleetCommand(command);
      const commandJson = canonicalFleetCommandJson(canonicalCommand);
      const commandHash = canonicalFleetCommandHash(canonicalCommand);
      invariant(state.worldId === canonicalCommand.worldId, "M5-Kommando verletzt die Weltisolation.");
      const entity = fleetCommandEntity(canonicalCommand);
      invariant(entity.entityId.length > 0, "M5-Kommando besitzt keine Entitaets-ID.");
      let replayReceiptJson: string | undefined;
      if (replayReceipt !== undefined) {
        fleetReceipt(replayReceipt, "M5-Replay-Receipt");
        invariant(replayReceipt.worldId === canonicalCommand.worldId, "M5-Replay-Receipt verletzt die Weltisolation.");
        invariant(replayReceipt.commandId === canonicalCommand.commandId, "M5-Replay-Receipt gehoert zu einem fremden Kommando.");
        invariant(replayReceipt.commandHash === commandHash, "M5-Replay-Receipt besitzt einen fremden Kommandohash.");
        invariant(replayReceipt.canonicalCommandJson === commandJson, "M5-Replay-Receipt besitzt eine fremde Kanonform.");
        invariant(
          replayReceipt.entityKind === entity.entityKind && replayReceipt.entityId === entity.entityId,
          "M5-Replay-Receipt gehoert zu einer fremden Entitaet.",
        );
        invariant(replayReceipt.resultingRevision === state.revision, "M5-Replay-Receipt bindet nicht den historischen Zustand.");
        replayReceiptJson = canonicalJson(replayReceipt, "M5-Replay-Receipt");
      }
      const result = decodeFleetCommandResult(addon.applyFleetCommand(
        JSON.stringify(state),
        commandJson,
        replayReceiptJson,
      ));
      invariant(result.state.worldId === canonicalCommand.worldId, "Rust-M5-Kommando verletzte die Weltisolation.");
      invariant(result.appliedCommandId === canonicalCommand.commandId, "Rust-M5-Kommando quittierte eine fremde Kommando-ID.");
      invariant(
        result.entityKind === entity.entityKind && result.entityId === entity.entityId,
        "Rust-M5-Kommando quittierte eine fremde Entitaet.",
      );
      invariant(result.commandReceipt.worldId === canonicalCommand.worldId, "Rust-M5-Receipt verletzte die Weltisolation.");
      invariant(result.commandReceipt.commandId === canonicalCommand.commandId, "Rust-M5-Receipt gehoert zu einem fremden Kommando.");
      invariant(result.commandReceipt.commandHash === commandHash, "Rust-M5-Receipt besitzt einen fremden Kommandohash.");
      invariant(result.commandReceipt.canonicalCommandJson === commandJson, "Rust-M5-Receipt besitzt eine fremde Kanonform.");
      invariant(
        result.commandReceipt.entityKind === entity.entityKind && result.commandReceipt.entityId === entity.entityId,
        "Rust-M5-Receipt gehoert zu einer fremden Entitaet.",
      );
      invariant(result.commandReceipt.resultingRevision === result.state.revision, "Rust-M5-Receipt bindet nicht die Ergebnisrevision.");
      invariant(result.idempotentReplay === (replayReceipt !== undefined), "Rust-M5-Kommando meldete einen unautorisierten Replay-Status.");
      invariant(result.idempotentReplay || result.state.revision === canonicalCommand.expectedRevision + 1, "Rust-M5-Kommando erhoehte die Revision nicht exakt einmal.");
      invariant(result.idempotentReplay || result.state.producedAt === canonicalCommand.atS, "Rust-M5-Kommando veraenderte die Zustandszeit.");
      invariant(result.commandReceipt.resultingStateHash === result.stateHash, "Rust-M5-Receipt bindet nicht den Ergebniszustandshash.");
      invariant(result.commandReceipt.resultingSnapshotHash === result.snapshotHash, "Rust-M5-Receipt bindet nicht den Ergebnis-Snapshothash.");
      if (replayReceipt !== undefined) {
        invariant(
          canonicalJson(result.commandReceipt, "Rust-M5-Receipt") === replayReceiptJson,
          "Rust-M5-Replay quittierte eine andere Receipt.",
        );
      }
      return result;
    },
    verifyFleetMobilizationSnapshot(snapshot: unknown) {
      const verified = decodeFleetVerification(addon.verifyFleetMobilizationSnapshot(JSON.stringify(snapshot)));
      record(snapshot, "M5-Snapshot");
      invariant(verified.worldId === snapshot["worldId"], "Rust-M5-Verifikation verletzte die Weltisolation.");
      invariant(verified.fleetRevision === snapshot["revision"], "Rust-M5-Verifikation lieferte eine fremde Revision.");
      return verified;
    },
    initialize(input: OperatingWorldInitialization) {
      const initialized = decodeInitialized(addon.initializeOperatingWorld(JSON.stringify(input)));
      invariant(initialized.state.worldId === input.worldId, "Rust-Initialisierung verletzte die Weltisolation.");
      return initialized;
    },
    applyTransition(
      state: OperatingWorldInitialized["state"],
      command: OperatingTransitionCommand,
    ) {
      invariant(state.worldId === command.worldId, "Runtime-Kommando verletzt die Weltisolation.");
      const result = decodeTransition(addon.applyOperatingTransition(JSON.stringify(state), JSON.stringify(command)));
      invariant(result.state.worldId === command.worldId, "Rust-Uebergang verletzte die Weltisolation.");
      invariant(result.outcome.lotId === command.lotId, "Rust-Uebergang gehoert zu einem anderen Los.");
      invariant(result.events.every((event) => event.worldId === command.worldId), "Rust-Ereignis verletzte die Weltisolation.");
      return result;
    },
  });
}

/**
 * Loads exactly the configured native addon. There is deliberately no JS
 * fallback: absence or an ABI error prevents production startup.
 */
export function loadOperatingRuntime(addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"]): NativeRuntime {
  invariant(addonPath !== undefined && addonPath.length > 0, "ZUGFOLGE_RUNTIME_NATIVE_PATH fehlt.");
  invariant(isAbsolute(addonPath), "ZUGFOLGE_RUNTIME_NATIVE_PATH muss absolut sein.");
  const required: unknown = createRequire(import.meta.url)(addonPath);
  record(required, "napi-rs-Addon");
  invariant(typeof required["initializeFleetWorld"] === "function", "napi-rs-Addon exportiert initializeFleetWorld nicht.");
  invariant(typeof required["applyFleetCommand"] === "function", "napi-rs-Addon exportiert applyFleetCommand nicht.");
  invariant(typeof required["verifyFleetMobilizationSnapshot"] === "function", "napi-rs-Addon exportiert verifyFleetMobilizationSnapshot nicht.");
  invariant(typeof required["initializeOperatingWorld"] === "function", "napi-rs-Addon exportiert initializeOperatingWorld nicht.");
  invariant(typeof required["applyOperatingTransition"] === "function", "napi-rs-Addon exportiert applyOperatingTransition nicht.");
  return operatingRuntimeFromAddon(required as unknown as NativeAddon);
}
