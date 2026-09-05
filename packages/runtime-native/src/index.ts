import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

export * from "./operational-simulation.js";
export * from "./demand.js";

export const OPERATING_INITIALIZE_SCHEMA = "zugfolge-operating-world-initialize/v1" as const;
export const OPERATING_STATE_SCHEMA = "zugfolge-operating-world-state/v1" as const;
export const OPERATING_TRANSITION_SCHEMA = "zugfolge-operating-transition-command/v1" as const;
export const OPERATING_RESULT_SCHEMA = "zugfolge-operating-transition-result/v1" as const;
export const FLEET_MOBILIZATION_VERIFICATION_SCHEMA = "zugfolge-fleet-mobilization-verification/v1" as const;
export const FLEET_STATE_VERIFICATION_SCHEMA = "zugfolge-fleet-world-state-verification/v1" as const;
export const FLEET_INITIALIZE_SCHEMA = "zugfolge-fleet-world-initialize/v2" as const;
export const FLEET_INITIALIZED_SCHEMA = "zugfolge-fleet-world-initialized/v2" as const;
export const FLEET_STATE_SCHEMA = "zugfolge-fleet-world-state/v2" as const;
export const FLEET_AUTHORITY_RELEASE_SCHEMA = "zugfolge-fleet-authority-release/v1" as const;
export const FLEET_AUTHORITY_RELEASE_SCHEMA_V2 = "zugfolge-fleet-authority-release/v2" as const;
export const FLEET_FORMATION_COMMAND_SCHEMA = "zugfolge-fleet-form-vehicles-command/v2" as const;
export const FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA = "zugfolge-fleet-assign-duty-command/v2" as const;
export const FLEET_PATH_RESERVATION_COMMAND_SCHEMA = "zugfolge-fleet-attach-path-command/v2" as const;
export const FLEET_ASSET_TRANSFER_COMMAND_SCHEMA = "zugfolge-fleet-transfer-asset-command/v1" as const;
export const FLEET_MAINTENANCE_COMMAND_SCHEMA = "zugfolge-fleet-schedule-maintenance-command/v1" as const;
export const FLEET_COMMAND_RESULT_SCHEMA = "zugfolge-fleet-command-result/v2" as const;
export const FLEET_COMMAND_RECEIPT_SCHEMA = "zugfolge-fleet-command-receipt/v1" as const;

export interface FleetMobilizationVerification {
  readonly schemaVersion: typeof FLEET_MOBILIZATION_VERIFICATION_SCHEMA;
  readonly worldId: string;
  readonly fleetRevision: number;
  readonly snapshotHash: string;
}

export interface FleetWorldStateVerification {
  readonly schemaVersion: typeof FLEET_STATE_VERIFICATION_SCHEMA;
  readonly worldId: string;
  readonly revision: number;
  readonly producedAt: number;
  readonly authorityReleaseHash: string;
  readonly stateHash: string;
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
  readonly traction: "unpowered" | "electric" | "diesel" | "battery" | "hydrogen";
  readonly replacementPlan: boolean;
}

export interface NativeFleetFormation {
  readonly id: string;
  readonly operatorId: string;
  readonly vehicleIds: readonly string[];
  /** Explizite Herkunft aus dem autoritativen Trassenbeleg; alte Snapshots duerfen das Feld noch auslassen. */
  readonly pathReceiptId?: string;
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
  readonly pathReceiptId?: string;
  readonly status: "ready" | "planned" | "uncovered";
  readonly validFrom: number;
  readonly validUntil: number;
}

export interface NativeFleetPathReservation {
  readonly id: string;
  readonly operatorId: string;
  readonly pathReceiptId?: string;
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

type FleetAuthorityTraction = "unpowered" | "electric" | "diesel" | "battery";
type FleetAuthorityPowerSystem = "ac15kv" | "ac25kv" | "dc750v" | "dc1500v" | "dc3000v";
type FleetAuthorityVehicleRole = "locomotive" | "powered-unit" | "coach" | "control-car";
type FleetAuthorityOrientation = "along" | "against";

export type FleetAuthorityVehicleRestriction =
  | Readonly<{ "power-basis-points": number }>
  | Readonly<{ "maximum-speed": number }>
  | Readonly<{ "service-brake": number }>
  | Readonly<{ "emergency-brake": number }>
  | Readonly<{ "protection-unavailable": "pzb" | "lzb" | "etcs-level1" | "etcs-level2" }>
  | Readonly<{ "door-availability-basis-points": number }>
  | "immobilized";

export interface FleetAuthorityControlStands {
  readonly front: boolean;
  readonly rear: boolean;
}

export interface FleetAuthorityVehicleCondition {
  readonly mechanicsBasisPoints: number;
  readonly driveBasisPoints: number;
  readonly brakesBasisPoints: number;
  readonly kilometresSinceMaintenance: number;
  readonly operatingHoursSinceMaintenance: number;
  readonly openObservations: number;
}

interface FleetAuthorityTechnicalDataBase {
  readonly lengthMm: number;
  readonly massKg: number;
  readonly maximumSpeedKph: number;
  readonly traction: FleetAuthorityTraction;
  readonly electricSystems: readonly FleetAuthorityPowerSystem[];
}

export interface FleetAuthorityTechnicalDataV1 extends FleetAuthorityTechnicalDataBase {
  readonly maximumSpeedMmps?: number;
  /**
   * Altes Referenzprofil. Bei einer Lok ist die wirksame Beschleunigung
   * formationsabhängig; Authority v2 leitet sie serverseitig aus Rohwerten ab.
   */
  readonly accelerationMmPerS2?: number;
  /** Siehe `accelerationMmPerS2`. */
  readonly decelerationMmPerS2?: number;
  /** Rohwert für Zugkraft-/Lastgrenzen; Legacy-Releases dürfen ihn noch auslassen. */
  readonly continuousPowerKw?: number;
  /** Anfahrzugkraft in kN; Legacy-Releases dürfen ihn noch auslassen. */
  readonly startingTractiveEffortKn?: number;
  /** Bremsgewicht in kg; Legacy-Releases dürfen ihn noch auslassen. */
  readonly brakeWeightKg?: number;
  readonly role?: FleetAuthorityVehicleRole;
  readonly controlStands?: FleetAuthorityControlStands;
}

/** Vollstaendige technische Compilerprojektion eines Authority-v2-Assets. */
export interface FleetAuthorityTechnicalDataV2 extends FleetAuthorityTechnicalDataBase {
  readonly maximumSpeedMmps: number;
  readonly accelerationMmPerS2: number;
  readonly decelerationMmPerS2: number;
  readonly continuousPowerKw: number;
  readonly startingTractiveEffortKn: number;
  readonly brakeWeightKg: number;
  readonly maximumAccelerationCapMmps2: number;
  readonly serviceBrakeCapMmps2: number;
  readonly emergencyBrakeMultiplierBasisPoints: number;
  readonly role: FleetAuthorityVehicleRole;
  readonly controlStands: FleetAuthorityControlStands;
}

export type FleetAuthorityTechnicalData = FleetAuthorityTechnicalDataV1 | FleetAuthorityTechnicalDataV2;

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

interface FleetAuthorityVehicleAssetBase<TTechnical extends FleetAuthorityTechnicalData> {
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
  readonly technical: TTechnical;
  readonly passenger: FleetAuthorityPassengerData;
  readonly deliveredAt: number;
  readonly retiredAt: number;
}

export interface FleetAuthorityVehicleAssetV1 extends FleetAuthorityVehicleAssetBase<FleetAuthorityTechnicalDataV1> {
  readonly orientation?: FleetAuthorityOrientation;
}

export interface FleetAuthorityVehicleAssetV2 extends FleetAuthorityVehicleAssetBase<FleetAuthorityTechnicalDataV2> {
  readonly orientation: FleetAuthorityOrientation;
  readonly condition: FleetAuthorityVehicleCondition;
  readonly restrictions: Readonly<Record<string, FleetAuthorityVehicleRestriction>>;
  readonly history: readonly string[];
}

export type FleetAuthorityVehicleAsset = FleetAuthorityVehicleAssetV1 | FleetAuthorityVehicleAssetV2;

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

interface FleetAuthorityReleaseBase<TAsset extends FleetAuthorityVehicleAsset> {
  readonly releaseId: string;
  readonly referenceYear: number;
  readonly assets: readonly TAsset[];
  readonly personnelPools: readonly FleetAuthorityPersonnelPool[];
  readonly pathReceipts: readonly FleetAuthorityPathReceipt[];
}

/** Rueckwaertskompatible Authority-v1-Quellfakten. */
export interface FleetAuthorityReleaseV1 extends FleetAuthorityReleaseBase<FleetAuthorityVehicleAssetV1> {
  readonly schemaVersion: typeof FLEET_AUTHORITY_RELEASE_SCHEMA;
  readonly economyReleaseId?: string;
  readonly economyReleaseSha256?: string;
}

/** Serververtrauenswuerdige, vollstaendige Authority-v2-Compilerprojektion. */
export interface FleetAuthorityReleaseV2 extends FleetAuthorityReleaseBase<FleetAuthorityVehicleAssetV2> {
  readonly schemaVersion: typeof FLEET_AUTHORITY_RELEASE_SCHEMA_V2;
  readonly economyReleaseId: string;
  readonly economyReleaseSha256: string;
}

export type FleetAuthorityRelease = FleetAuthorityReleaseV1 | FleetAuthorityReleaseV2;

export interface FleetWorldInitialization {
  readonly schemaVersion: typeof FLEET_INITIALIZE_SCHEMA;
  readonly worldId: string;
  readonly producedAt: number;
  readonly authorityRelease: FleetAuthorityRelease;
  /** Rueckwaertskompatibler Bootstrap des vollstaendigen Eigenbetriebs bei t=0. */
  readonly formations?: readonly NativeFleetFormationIntent[];
  readonly personnelDuties?: readonly NativeFleetPersonnelDutyIntent[];
  readonly pathReservations?: readonly NativeFleetPathReservationIntent[];
}

/** Serverautoritativ abgeleitetes Ganzzahlprofil einer konkreten Formation. */
export interface NativeFleetFormationDynamics {
  readonly accelerationMmPerS2: number;
  readonly decelerationMmPerS2: number;
}

export interface NativeFleetFormationIntent {
  readonly id: string;
  readonly vehicleIds: readonly string[];
  readonly pathReceiptId: string;
  readonly dynamics?: NativeFleetFormationDynamics;
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

export interface NativeFleetAssetHolding {
  readonly ownerOperatorId: string;
  readonly holderOperatorId: string;
  readonly lessorOperatorId: string | null;
  readonly contractId: string | null;
  readonly validUntilS: number | null;
  readonly historyHash: string;
}

export interface NativeFleetMaintenanceAssignment {
  readonly formationId: string;
  readonly facilityId: string;
  readonly startsAtS: number;
  readonly endsAtS: number;
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
  readonly assetHoldings?: Readonly<Record<string, NativeFleetAssetHolding>>;
  readonly maintenanceAssignments?: Readonly<Record<string, NativeFleetMaintenanceAssignment>>;
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
      readonly dynamics?: NativeFleetFormationDynamics;
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
    }
  | FleetCommandBase & {
      readonly schemaVersion: typeof FLEET_ASSET_TRANSFER_COMMAND_SCHEMA;
      readonly vehicleId: string;
      readonly transferType: "sale" | "rental-start" | "rental-return" | "reversal";
      readonly fromOwnerOperatorId: string;
      readonly toOwnerOperatorId: string;
      readonly fromHolderOperatorId: string;
      readonly toHolderOperatorId: string;
      readonly lessorOperatorId: string | null;
      readonly contractId: string | null;
      readonly validUntilS: number | null;
      readonly transferReceiptHash: string;
    }
  | FleetCommandBase & {
      readonly schemaVersion: typeof FLEET_MAINTENANCE_COMMAND_SCHEMA;
      readonly formationId: string;
      readonly facilityId: string;
      readonly startsAtS: number;
      readonly endsAtS: number;
    };

export interface FleetCommandReceipt {
  readonly schemaVersion: typeof FLEET_COMMAND_RECEIPT_SCHEMA;
  readonly worldId: string;
  readonly commandId: string;
  readonly commandHash: string;
  readonly canonicalCommandJson: string;
  readonly resultingRevision: number;
  readonly entityKind: "formation" | "personnel-duty" | "path-reservation" | "asset-holding" | "maintenance-assignment";
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
  readonly entityKind: "formation" | "personnel-duty" | "path-reservation" | "asset-holding" | "maintenance-assignment";
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
  readonly nextTimetableBoundaryS?: number;
  readonly reason?: "failed-tender";
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

export interface OperatingDispatchCase {
  readonly decision_id: number;
  readonly train_run_id: number;
  readonly event_at: number;
  readonly trigger: Readonly<Record<string, unknown>>;
  readonly delay_seconds: number;
  readonly connection_threatened: boolean;
  readonly vehicle_failed: boolean;
  readonly duty_excess_seconds: number;
  readonly route_closed: boolean;
  readonly platform_changed: boolean;
  readonly turnaround_shortfall_seconds: number;
  readonly adhoc_conflict: boolean;
  readonly hold_until: number;
  readonly limits: Readonly<Record<
    | "capacity_available" | "train_characteristics_compatible" | "route_knowledge_available"
    | "train_protection_compatible" | "electrification_compatible" | "train_length_allowed"
    | "vehicle_available" | "maintenance_valid" | "personnel_qualified" | "rest_time_compliant"
    | "rotation_feasible" | "contract_allows" | "cost_within_limit",
    boolean
  >>;
  readonly impact: {
    readonly affected_train_runs: number;
    readonly affected_connections: number;
    readonly affected_rotations: number;
    readonly affected_personnel_pools: number;
    readonly affected_vehicles: number;
    readonly cost_cents: number;
    readonly contract_penalty_cents: number;
    readonly cancelled_stops: number;
    readonly cause: string;
    readonly affected_resource: string;
    readonly contract_effect: string;
  };
  readonly manual_action: "short_turn" | "request_reroute" | "trigger_rail_replacement";
  readonly manual_reason: string;
}

export interface OperatingDecisionExplanation extends Readonly<Record<string, unknown>> {
  readonly decision_id: number;
  readonly world_id: string;
  readonly operator_id: string;
  readonly train_run_id: number;
  readonly program_version: number;
  readonly program_checksum: string;
  readonly selected_rule_id: string | null;
  readonly selected_action: string | null;
  readonly manual_override: boolean;
  readonly outcome_reason: string;
  readonly impact: Readonly<Record<string, unknown>>;
}

export interface FleetRuntime {
  readonly initializeFleet: (input: FleetWorldInitialization) => FleetWorldInitialized;
  readonly verifyFleetWorldState: (
    state: NativeFleetWorldState,
    expectedStateHash: string,
  ) => FleetWorldStateVerification;
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
  readonly evaluateDecision: (
    program: Readonly<Record<string, unknown>>,
    dispatchCase: OperatingDispatchCase,
  ) => OperatingDecisionExplanation;
}

export type NativeRuntime = FleetRuntime & OperatingRuntime;

interface NativeAddon {
  readonly initializeFleetWorld: (inputJson: string) => string;
  readonly verifyFleetWorldState: (stateJson: string, expectedStateHash: string) => string;
  readonly applyFleetCommand: (stateJson: string, commandJson: string, replayReceiptJson?: string) => string;
  readonly verifyFleetMobilizationSnapshot: (inputJson: string) => string;
  readonly initializeOperatingWorld: (inputJson: string) => string;
  readonly applyOperatingTransition: (stateJson: string, commandJson: string) => string;
  readonly evaluateOperatingDecision?: (programJson: string, caseJson: string) => string;
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

function orderedUniqueStringList(value: unknown, name: string): readonly string[] {
  invariant(Array.isArray(value) && value.length > 0, `${name} ist keine nichtleere Kennungsliste.`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    nonEmptyString(item, `${name}[${index}]`);
    invariant(!seen.has(item), `${name} enthaelt doppelte Kennungen.`);
    seen.add(item);
    return item;
  });
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

function formationDynamics(
  value: unknown,
  name: string,
): NativeFleetFormationDynamics {
  record(value, name);
  const acceleration = value["accelerationMmPerS2"];
  const deceleration = value["decelerationMmPerS2"];
  safeInteger(acceleration, `${name}-Beschleunigung`);
  safeInteger(deceleration, `${name}-Bremsvermoegen`);
  invariant(
    acceleration > 0 && deceleration > 0,
    `${name} muss positive Beschleunigungs- und Bremswerte enthalten.`,
  );
  const keys = Object.keys(value);
  invariant(
    keys.length === 2
      && keys.includes("accelerationMmPerS2")
      && keys.includes("decelerationMmPerS2"),
    `${name} enthaelt unbekannte oder fehlende Felder.`,
  );
  return {
    accelerationMmPerS2: acceleration,
    decelerationMmPerS2: deceleration,
  };
}

function normalizeFleetCommand(command: NativeFleetCommand): NativeFleetCommand {
  record(command, "M5-Kommando");
  commonFleetCommand(command);
  switch (command.schemaVersion) {
    case FLEET_FORMATION_COMMAND_SCHEMA: {
      const hasDynamics = Object.hasOwn(command, "dynamics");
      exactFleetCommandFields(command, [
        "formationId",
        "vehicleIds",
        "pathReceiptId",
        ...(hasDynamics ? ["dynamics"] : []),
      ]);
      nonEmptyString(command.formationId, "M5-Formation-ID");
      nonEmptyString(command.pathReceiptId, "M5-Trassenbeleg-ID");
      const dynamics = hasDynamics
        ? formationDynamics(command.dynamics, "M5-Formations-Fahrprofil")
        : undefined;
      return {
        schemaVersion: command.schemaVersion,
        worldId: command.worldId,
        commandId: command.commandId,
        expectedStateHash: command.expectedStateHash,
        expectedRevision: command.expectedRevision,
        atS: command.atS,
        formationId: command.formationId,
        vehicleIds: orderedUniqueStringList(command.vehicleIds, "M5-Fahrzeug-IDs"),
        pathReceiptId: command.pathReceiptId,
        ...(dynamics === undefined ? {} : { dynamics }),
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
    case FLEET_ASSET_TRANSFER_COMMAND_SCHEMA:
      exactFleetCommandFields(command, [
        "vehicleId",
        "transferType",
        "fromOwnerOperatorId",
        "toOwnerOperatorId",
        "fromHolderOperatorId",
        "toHolderOperatorId",
        "lessorOperatorId",
        "contractId",
        "validUntilS",
        "transferReceiptHash",
      ]);
      nonEmptyString(command.vehicleId, "M5-Transfer-Fahrzeug");
      invariant(["sale", "rental-start", "rental-return", "reversal"].includes(command.transferType), "M5-Transferart ist ungueltig.");
      nonEmptyString(command.fromOwnerOperatorId, "M5-Transfer-Alteigentuemer");
      nonEmptyString(command.toOwnerOperatorId, "M5-Transfer-Neueigentuemer");
      nonEmptyString(command.fromHolderOperatorId, "M5-Transfer-Althalter");
      nonEmptyString(command.toHolderOperatorId, "M5-Transfer-Neuhalter");
      if (command.lessorOperatorId !== null) nonEmptyString(command.lessorOperatorId, "M5-Transfer-Vermieter");
      if (command.contractId !== null) nonEmptyString(command.contractId, "M5-Transfer-Vertrag");
      if (command.validUntilS !== null) safeInteger(command.validUntilS, "M5-Transfer-Ende");
      sha256(command.transferReceiptHash, "M5-Transfer-Beleghash");
      return {
        schemaVersion: command.schemaVersion,
        worldId: command.worldId,
        commandId: command.commandId,
        expectedStateHash: command.expectedStateHash,
        expectedRevision: command.expectedRevision,
        atS: command.atS,
        vehicleId: command.vehicleId,
        transferType: command.transferType,
        fromOwnerOperatorId: command.fromOwnerOperatorId,
        toOwnerOperatorId: command.toOwnerOperatorId,
        fromHolderOperatorId: command.fromHolderOperatorId,
        toHolderOperatorId: command.toHolderOperatorId,
        lessorOperatorId: command.lessorOperatorId,
        contractId: command.contractId,
        validUntilS: command.validUntilS,
        transferReceiptHash: command.transferReceiptHash,
      };
    case FLEET_MAINTENANCE_COMMAND_SCHEMA:
      exactFleetCommandFields(command, ["formationId", "facilityId", "startsAtS", "endsAtS"]);
      nonEmptyString(command.formationId, "M5-Werkstatt-Formation");
      nonEmptyString(command.facilityId, "M5-Werkstatt-Anlage");
      safeInteger(command.startsAtS, "M5-Werkstatt-Beginn");
      safeInteger(command.endsAtS, "M5-Werkstatt-Ende");
      invariant(command.startsAtS >= command.atS && command.endsAtS > command.startsAtS, "M5-Werkstattfenster ist ungueltig.");
      return {
        schemaVersion: command.schemaVersion,
        worldId: command.worldId,
        commandId: command.commandId,
        expectedStateHash: command.expectedStateHash,
        expectedRevision: command.expectedRevision,
        atS: command.atS,
        formationId: command.formationId,
        facilityId: command.facilityId,
        startsAtS: command.startsAtS,
        endsAtS: command.endsAtS,
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

/** Normalisiert mengenartige IDs, bewahrt aber die fachliche Fahrzeugreihenfolge Spitze -> Schluss. */
export function canonicalizeFleetCommand(command: NativeFleetCommand): NativeFleetCommand {
  return JSON.parse(canonicalJson(normalizeFleetCommand(command), "M5-Kommando")) as NativeFleetCommand;
}

/**
 * Bindet die Formation-Kanonisierung an das im Zustand gepinnte Authority-Schema:
 * v1 behandelt Fahrzeug-IDs weiterhin als historische Menge, v2 als fachliche
 * Reihenfolge von Zugspitze nach Zugschluss.
 */
export function canonicalizeFleetCommandForState(
  state: Pick<NativeFleetWorldState, "authorityRelease">,
  command: NativeFleetCommand,
): NativeFleetCommand {
  const authorityCompatibleCommand = state.authorityRelease.schemaVersion === FLEET_AUTHORITY_RELEASE_SCHEMA
    && command.schemaVersion === FLEET_FORMATION_COMMAND_SCHEMA
    ? { ...command, vehicleIds: canonicalStringSet(command.vehicleIds, "M5-Fahrzeug-IDs") }
    : command;
  return canonicalizeFleetCommand(authorityCompatibleCommand);
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
    case FLEET_ASSET_TRANSFER_COMMAND_SCHEMA:
      return { entityKind: "asset-holding", entityId: command.vehicleId };
    case FLEET_MAINTENANCE_COMMAND_SCHEMA:
      return { entityKind: "maintenance-assignment", entityId: command.formationId };
  }
}

const AUTHORITY_TRACTIONS = ["unpowered", "electric", "diesel", "battery"] as const;
const AUTHORITY_POWER_SYSTEMS = ["ac15kv", "ac25kv", "dc750v", "dc1500v", "dc3000v"] as const;
const AUTHORITY_ROLES = ["locomotive", "powered-unit", "coach", "control-car"] as const;
const AUTHORITY_ORIENTATIONS = ["along", "against"] as const;
const AUTHORITY_PROTECTION_SYSTEMS = ["pzb", "lzb", "etcs-level1", "etcs-level2"] as const;
const AUTHORITY_PROCUREMENT_CHANNELS = ["new-build", "leasing", "used"] as const;
const AUTHORITY_PATH_DECISIONS = ["confirmed", "requested", "rejected"] as const;
const AUTHORITY_ELECTRIFICATIONS = [
  "unelectrified",
  "overhead-ac15kv",
  "overhead-ac25kv",
  "overhead-dc1500v",
  "overhead-dc3000v",
] as const;

function exactAuthorityFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const missing = required.filter((field) => !Object.hasOwn(value, field));
  invariant(missing.length === 0, `${name} fehlt Pflichtfeld '${missing[0]}'.`);
  const allowed = new Set([...required, ...optional]);
  const ownKeys = Reflect.ownKeys(value);
  invariant(
    ownKeys.every((key) => typeof key === "string" && allowed.has(key))
      && ownKeys.length === Object.keys(value).length,
    `${name} enthaelt unbekannte oder nicht serialisierbare Felder.`,
  );
}

function authorityBoolean(value: unknown, name: string): asserts value is boolean {
  invariant(typeof value === "boolean", `${name} ist kein boolescher Wert.`);
}

function authorityEnum(value: unknown, allowed: readonly string[], name: string): asserts value is string {
  invariant(typeof value === "string" && allowed.includes(value), `${name} besitzt einen unbekannten Wert.`);
}

function authorityStringList(
  value: unknown,
  name: string,
  requireNonEmpty: boolean,
): asserts value is readonly string[] {
  invariant(Array.isArray(value), `${name} ist keine Kennungsliste.`);
  invariant(!requireNonEmpty || value.length > 0, `${name} darf nicht leer sein.`);
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    nonEmptyString(item, `${name}[${index}]`);
    invariant(!seen.has(item), `${name} enthaelt doppelte Eintraege.`);
    seen.add(item);
  }
}

function authorityEnumList(
  value: unknown,
  allowed: readonly string[],
  name: string,
  requireNonEmpty: boolean,
): asserts value is readonly string[] {
  invariant(Array.isArray(value), `${name} ist keine Werteliste.`);
  invariant(!requireNonEmpty || value.length > 0, `${name} darf nicht leer sein.`);
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    authorityEnum(item, allowed, `${name}[${index}]`);
    invariant(!seen.has(item), `${name} enthaelt doppelte Eintraege.`);
    seen.add(item);
  }
}

function positiveSafeInteger(value: unknown, name: string): asserts value is number {
  safeInteger(value, name);
  invariant(value > 0, `${name} ist nicht positiv.`);
}

function boundedSafeInteger(value: unknown, maximum: number, name: string): asserts value is number {
  safeInteger(value, name);
  invariant(value <= maximum, `${name} liegt ausserhalb des zulaessigen Ganzzahlbereichs.`);
}

function authorityControlStands(value: unknown, name: string): asserts value is FleetAuthorityControlStands {
  record(value, name);
  exactAuthorityFields(value, ["front", "rear"], [], name);
  authorityBoolean(value["front"], `${name}.front`);
  authorityBoolean(value["rear"], `${name}.rear`);
}

function authorityTechnicalData(value: unknown, name: string, authorityV2: boolean): void {
  record(value, name);
  const legacyOptionalFields = [
    "maximumSpeedMmps",
    "accelerationMmPerS2",
    "decelerationMmPerS2",
    "continuousPowerKw",
    "startingTractiveEffortKn",
    "brakeWeightKg",
    "role",
    "controlStands",
  ] as const;
  const rawV2Fields = [
    "maximumAccelerationCapMmps2",
    "serviceBrakeCapMmps2",
    "emergencyBrakeMultiplierBasisPoints",
  ] as const;
  const v2Fields = [...legacyOptionalFields, ...rawV2Fields] as const;
  exactAuthorityFields(
    value,
    ["lengthMm", "massKg", "maximumSpeedKph", "traction", "electricSystems", ...(authorityV2 ? v2Fields : [])],
    authorityV2 ? [] : legacyOptionalFields,
    name,
  );
  positiveSafeInteger(value["lengthMm"], `${name}.lengthMm`);
  positiveSafeInteger(value["massKg"], `${name}.massKg`);
  positiveSafeInteger(value["maximumSpeedKph"], `${name}.maximumSpeedKph`);
  invariant((value["maximumSpeedKph"] as number) <= 65_535, `${name}.maximumSpeedKph liegt ausserhalb von u16.`);
  authorityEnum(value["traction"], AUTHORITY_TRACTIONS, `${name}.traction`);
  authorityEnumList(value["electricSystems"], AUTHORITY_POWER_SYSTEMS, `${name}.electricSystems`, false);
  for (const field of [
    "maximumSpeedMmps",
    "accelerationMmPerS2",
    "decelerationMmPerS2",
    "continuousPowerKw",
    "startingTractiveEffortKn",
    "brakeWeightKg",
    "maximumAccelerationCapMmps2",
    "serviceBrakeCapMmps2",
    "emergencyBrakeMultiplierBasisPoints",
  ] as const) {
    if (Object.hasOwn(value, field)) safeInteger(value[field], `${name}.${field}`);
  }
  if (Object.hasOwn(value, "role")) authorityEnum(value["role"], AUTHORITY_ROLES, `${name}.role`);
  if (Object.hasOwn(value, "controlStands")) authorityControlStands(value["controlStands"], `${name}.controlStands`);
  const acceleration = Object.hasOwn(value, "accelerationMmPerS2") ? value["accelerationMmPerS2"] as number : 0;
  const deceleration = Object.hasOwn(value, "decelerationMmPerS2") ? value["decelerationMmPerS2"] as number : 0;
  const continuousPower = Object.hasOwn(value, "continuousPowerKw") ? value["continuousPowerKw"] as number : 0;
  const startingEffort = Object.hasOwn(value, "startingTractiveEffortKn")
    ? value["startingTractiveEffortKn"] as number
    : 0;
  const traction = value["traction"] as string;
  const unpowered = traction === "unpowered";
  const hasLegacyDynamics = acceleration > 0 && deceleration > 0;
  const omitsLegacyDynamics = acceleration === 0 && deceleration === 0;
  invariant(
    unpowered
      ? omitsLegacyDynamics
      : authorityV2
        ? continuousPower > 0 && startingEffort > 0 && (hasLegacyDynamics || omitsLegacyDynamics)
        : hasLegacyDynamics || (omitsLegacyDynamics && continuousPower > 0 && startingEffort > 0),
    `${name} besitzt keine konsistente Fahrdynamik oder Rohtraktion.`,
  );
  if (authorityV2) {
    const brakeWeight = value["brakeWeightKg"] as number;
    const accelerationCap = value["maximumAccelerationCapMmps2"] as number;
    const serviceBrakeCap = value["serviceBrakeCapMmps2"] as number;
    const emergencyMultiplier = value["emergencyBrakeMultiplierBasisPoints"] as number;
    positiveSafeInteger(brakeWeight, `${name}.brakeWeightKg`);
    boundedSafeInteger(accelerationCap, 10_000, `${name}.maximumAccelerationCapMmps2`);
    boundedSafeInteger(serviceBrakeCap, 20_000, `${name}.serviceBrakeCapMmps2`);
    invariant(serviceBrakeCap > 0, `${name}.serviceBrakeCapMmps2 ist nicht positiv.`);
    boundedSafeInteger(
      emergencyMultiplier,
      30_000,
      `${name}.emergencyBrakeMultiplierBasisPoints`,
    );
    invariant(
      emergencyMultiplier > 10_000,
      `${name}.emergencyBrakeMultiplierBasisPoints muss ueber 10000 liegen.`,
    );
    invariant(
      unpowered
        ? continuousPower === 0 && startingEffort === 0 && accelerationCap === 0
        : continuousPower > 0 && startingEffort > 0 && accelerationCap > 0,
      `${name} bindet Rohtraktion und Beschleunigungs-Cap nicht an die Fahrzeugrolle.`,
    );
    const accelerationNumerator = startingEffort * 1_000_000;
    const serviceNumerator = brakeWeight * 9_806;
    invariant(
      Number.isSafeInteger(accelerationNumerator) && Number.isSafeInteger(serviceNumerator),
      `${name} laesst die ganzzahlige Rohdynamik ueberlaufen.`,
    );
    const expectedAcceleration = unpowered
      ? 0
      : Math.min(accelerationCap, Math.floor(accelerationNumerator / (value["massKg"] as number)));
    const expectedServiceBrake = Math.min(
      serviceBrakeCap,
      Math.floor(serviceNumerator / (value["massKg"] as number)),
    );
    const emergencyNumerator = expectedServiceBrake * emergencyMultiplier;
    invariant(
      Number.isSafeInteger(emergencyNumerator),
      `${name} laesst die Schnellbremsableitung ueberlaufen.`,
    );
    const expectedEmergencyBrake = Math.floor(emergencyNumerator / 10_000);
    invariant(
      (unpowered || expectedAcceleration > 0)
        && expectedServiceBrake > 0
        && expectedEmergencyBrake > expectedServiceBrake
        && expectedEmergencyBrake <= 20_000,
      `${name} besitzt keine sichere Rohdynamikableitung.`,
    );
    invariant(
      !hasLegacyDynamics
        || (acceleration === expectedAcceleration && deceleration === expectedServiceBrake),
      `${name} besitzt ein nicht reproduzierbares Referenzprofil.`,
    );
  }
  const electricSystems = value["electricSystems"] as readonly string[];
  const requiresElectricSystems = traction === "electric" || (authorityV2 && traction === "battery");
  invariant(
    requiresElectricSystems === (electricSystems.length > 0),
    `${name}.electricSystems ist zur Traktion inkonsistent.`,
  );
  const role = Object.hasOwn(value, "role") ? value["role"] as string : "powered-unit";
  const controlStands = Object.hasOwn(value, "controlStands")
    ? value["controlStands"] as FleetAuthorityControlStands
    : { front: true, rear: true };
  switch (role) {
    case "coach":
      invariant(
        unpowered && !controlStands.front && !controlStands.rear,
        `${name} beschreibt keinen konsistenten Reisezugwagen.`,
      );
      break;
    case "control-car":
      invariant(
        unpowered && (controlStands.front || controlStands.rear),
        `${name} beschreibt keinen konsistenten Steuerwagen.`,
      );
      break;
    case "locomotive":
    case "powered-unit":
      invariant(
        !unpowered && (!authorityV2 || controlStands.front || controlStands.rear),
        `${name} beschreibt kein konsistentes angetriebenes Fahrzeug.`,
      );
      break;
  }
  if (authorityV2) {
    const expectedMmps = Math.floor((value["maximumSpeedKph"] as number) * 1_000_000 / 3_600);
    invariant(
      value["maximumSpeedMmps"] === expectedMmps,
      `${name}.maximumSpeedMmps ist nicht die exakte abgerundete v2-Geschwindigkeit.`,
    );
  }
}

function authorityPassengerData(value: unknown, name: string): void {
  record(value, name);
  exactAuthorityFields(value, [
    "seats",
    "firstClassSeats",
    "accessible",
    "bicyclePlaces",
    "wheelchairPlaces",
    "equipment",
    "operatingCostCentsPerTrainKm",
    "replacementPlan",
  ], [], name);
  boundedSafeInteger(value["seats"], 4_294_967_295, `${name}.seats`);
  boundedSafeInteger(value["firstClassSeats"], 4_294_967_295, `${name}.firstClassSeats`);
  boundedSafeInteger(value["bicyclePlaces"], 65_535, `${name}.bicyclePlaces`);
  boundedSafeInteger(value["wheelchairPlaces"], 65_535, `${name}.wheelchairPlaces`);
  boundedSafeInteger(
    value["operatingCostCentsPerTrainKm"],
    4_294_967_295,
    `${name}.operatingCostCentsPerTrainKm`,
  );
  invariant(
    (value["firstClassSeats"] as number) <= (value["seats"] as number),
    `${name}.firstClassSeats uebersteigt die Sitzplatzzahl.`,
  );
  authorityBoolean(value["accessible"], `${name}.accessible`);
  authorityBoolean(value["replacementPlan"], `${name}.replacementPlan`);
  authorityStringList(value["equipment"], `${name}.equipment`, false);
}

function authorityRestrictions(value: unknown, name: string): void {
  record(value, name);
  for (const [restrictionId, rawRestriction] of Object.entries(value)) {
    nonEmptyString(restrictionId, `${name} key`);
    if (rawRestriction === "immobilized") continue;
    record(rawRestriction, `${name}.${restrictionId}`);
    const keys = Object.keys(rawRestriction);
    invariant(keys.length === 1, `${name}.${restrictionId} besitzt keine eindeutige Variante.`);
    const variant = keys[0];
    invariant(variant !== undefined, `${name}.${restrictionId} besitzt keine Variante.`);
    const detail = rawRestriction[variant];
    switch (variant) {
      case "power-basis-points":
        boundedSafeInteger(detail, 10_000, `${name}.${restrictionId}.${variant}`);
        invariant((detail as number) > 0, `${name}.${restrictionId}.${variant} muss positiv sein.`);
        break;
      case "door-availability-basis-points":
        boundedSafeInteger(detail, 10_000, `${name}.${restrictionId}.${variant}`);
        invariant((detail as number) >= 0, `${name}.${restrictionId}.${variant} ist negativ.`);
        break;
      case "maximum-speed":
      case "service-brake":
      case "emergency-brake":
        positiveSafeInteger(detail, `${name}.${restrictionId}.${variant}`);
        invariant((detail as number) <= 4_294_967_295, `${name}.${restrictionId}.${variant} liegt ausserhalb von u32.`);
        break;
      case "protection-unavailable":
        authorityEnum(detail, AUTHORITY_PROTECTION_SYSTEMS, `${name}.${restrictionId}.${variant}`);
        break;
      default:
        invariant(false, `${name}.${restrictionId} besitzt eine unbekannte Variante.`);
    }
  }
}

function authorityCondition(value: unknown, name: string): void {
  record(value, name);
  exactAuthorityFields(
    value,
    [
      "mechanicsBasisPoints",
      "driveBasisPoints",
      "brakesBasisPoints",
      "kilometresSinceMaintenance",
      "operatingHoursSinceMaintenance",
      "openObservations",
    ],
    [],
    name,
  );
  for (const field of ["mechanicsBasisPoints", "driveBasisPoints", "brakesBasisPoints"] as const) {
    boundedSafeInteger(value[field], 10_000, `${name}.${field}`);
  }
  safeInteger(value["kilometresSinceMaintenance"], `${name}.kilometresSinceMaintenance`);
  safeInteger(value["operatingHoursSinceMaintenance"], `${name}.operatingHoursSinceMaintenance`);
  boundedSafeInteger(value["openObservations"], 65_535, `${name}.openObservations`);
}

function authorityHistory(value: unknown, name: string): void {
  invariant(Array.isArray(value), `${name} ist keine geordnete Historienliste.`);
  for (const [index, entry] of value.entries()) {
    nonEmptyString(entry, `${name}[${index}]`);
    invariant(entry.trim() === entry, `${name}[${index}] ist nicht randfrei.`);
  }
}

function authorityVehicleAsset(
  value: unknown,
  name: string,
  authorityV2: boolean,
  referenceYear: number,
): void {
  record(value, name);
  const commonFields = [
    "id",
    "numericId",
    "operatorId",
    "vehicleTypeId",
    "classDesignation",
    "tradeName",
    "buildYear",
    "acquisitionYear",
    "procurementChannel",
    "approvedLineIds",
    "maintenanceDeadlines",
    "installedProtection",
    "technical",
    "passenger",
    "deliveredAt",
    "retiredAt",
  ] as const;
  exactAuthorityFields(
    value,
    [...commonFields, ...(authorityV2 ? ["orientation", "condition", "restrictions", "history"] : [])],
    authorityV2 ? [] : ["orientation"],
    name,
  );
  for (const field of ["id", "operatorId", "classDesignation", "tradeName"] as const) {
    nonEmptyString(value[field], `${name}.${field}`);
  }
  positiveSafeInteger(value["numericId"], `${name}.numericId`);
  positiveSafeInteger(value["vehicleTypeId"], `${name}.vehicleTypeId`);
  boundedSafeInteger(value["buildYear"], 65_535, `${name}.buildYear`);
  boundedSafeInteger(value["acquisitionYear"], 65_535, `${name}.acquisitionYear`);
  invariant(
    (value["buildYear"] as number) > 0 && (value["acquisitionYear"] as number) > 0,
    `${name} besitzt kein positives Jahr.`,
  );
  invariant(
    (value["buildYear"] as number) <= (value["acquisitionYear"] as number)
      && (value["buildYear"] as number) <= referenceYear
      && (!authorityV2 || (value["acquisitionYear"] as number) <= referenceYear),
    `${name} besitzt inkonsistente Bau- oder Beschaffungsjahre.`,
  );
  authorityEnum(value["procurementChannel"], AUTHORITY_PROCUREMENT_CHANNELS, `${name}.procurementChannel`);
  authorityStringList(value["approvedLineIds"], `${name}.approvedLineIds`, true);
  invariant(
    Array.isArray(value["maintenanceDeadlines"]) && value["maintenanceDeadlines"].length > 0,
    `${name}.maintenanceDeadlines darf nicht leer sein.`,
  );
  const deadlineKinds = new Set<string>();
  for (const [index, rawDeadline] of value["maintenanceDeadlines"].entries()) {
    const deadlineName = `${name}.maintenanceDeadlines[${index}]`;
    record(rawDeadline, deadlineName);
    exactAuthorityFields(rawDeadline, ["kind", "dueAt"], [], deadlineName);
    nonEmptyString(rawDeadline["kind"], `${deadlineName}.kind`);
    invariant(!deadlineKinds.has(rawDeadline["kind"]), `${name}.maintenanceDeadlines enthaelt doppelte Arten.`);
    deadlineKinds.add(rawDeadline["kind"]);
    safeInteger(rawDeadline["dueAt"], `${deadlineName}.dueAt`);
  }
  authorityEnumList(value["installedProtection"], AUTHORITY_PROTECTION_SYSTEMS, `${name}.installedProtection`, false);
  if (Object.hasOwn(value, "orientation")) {
    authorityEnum(value["orientation"], AUTHORITY_ORIENTATIONS, `${name}.orientation`);
  }
  if (authorityV2) {
    authorityCondition(value["condition"], `${name}.condition`);
    authorityRestrictions(value["restrictions"], `${name}.restrictions`);
    authorityHistory(value["history"], `${name}.history`);
  }
  authorityTechnicalData(value["technical"], `${name}.technical`, authorityV2);
  authorityPassengerData(value["passenger"], `${name}.passenger`);
  const technical = value["technical"] as Record<string, unknown>;
  const passenger = value["passenger"] as Record<string, unknown>;
  const role = Object.hasOwn(technical, "role") ? technical["role"] as string : "powered-unit";
  const installedProtection = value["installedProtection"] as readonly string[];
  invariant(
    !installedProtection.includes("lzb") || installedProtection.includes("pzb"),
    `${name}.installedProtection darf LZB nur mit PZB enthalten.`,
  );
  invariant(
    role === "coach"
      || installedProtection.some((system) => ["pzb", "etcs-level1", "etcs-level2"].includes(system)),
    `${name} besitzt fuer seine Fahrzeugrolle weder PZB noch ETCS.`,
  );
  invariant(
    role === "locomotive" || (passenger["seats"] as number) > 0,
    `${name}.passenger.seats ist fuer die Fahrzeugrolle nicht positiv.`,
  );
  safeInteger(value["deliveredAt"], `${name}.deliveredAt`);
  safeInteger(value["retiredAt"], `${name}.retiredAt`);
  invariant((value["retiredAt"] as number) > (value["deliveredAt"] as number), `${name} besitzt kein positives Zeitfenster.`);
}

function authorityPersonnelPool(value: unknown, name: string): void {
  record(value, name);
  exactAuthorityFields(value, [
    "id",
    "numericId",
    "operatorId",
    "capacitySeconds",
    "minimumRestSeconds",
    "classDesignations",
    "pathReceiptIds",
    "qualificationHash",
  ], [], name);
  nonEmptyString(value["id"], `${name}.id`);
  positiveSafeInteger(value["numericId"], `${name}.numericId`);
  nonEmptyString(value["operatorId"], `${name}.operatorId`);
  boundedSafeInteger(value["capacitySeconds"], 4_294_967_295, `${name}.capacitySeconds`);
  invariant((value["capacitySeconds"] as number) > 0, `${name}.capacitySeconds ist nicht positiv.`);
  boundedSafeInteger(value["minimumRestSeconds"], 4_294_967_295, `${name}.minimumRestSeconds`);
  authorityStringList(value["classDesignations"], `${name}.classDesignations`, true);
  authorityStringList(value["pathReceiptIds"], `${name}.pathReceiptIds`, true);
  sha256(value["qualificationHash"], `${name}.qualificationHash`);
}

function authorityPathReceipt(value: unknown, name: string): void {
  record(value, name);
  exactAuthorityFields(value, [
    "id",
    "numericRouteId",
    "operatorId",
    "serviceLineIds",
    "decision",
    "validFrom",
    "validUntil",
    "platformLengthsMm",
    "electrifications",
    "requiredProtection",
    "approvedClasses",
    "plannerStateHash",
    "conflictCheckHash",
  ], [], name);
  nonEmptyString(value["id"], `${name}.id`);
  positiveSafeInteger(value["numericRouteId"], `${name}.numericRouteId`);
  nonEmptyString(value["operatorId"], `${name}.operatorId`);
  authorityStringList(value["serviceLineIds"], `${name}.serviceLineIds`, true);
  authorityEnum(value["decision"], AUTHORITY_PATH_DECISIONS, `${name}.decision`);
  safeInteger(value["validFrom"], `${name}.validFrom`);
  safeInteger(value["validUntil"], `${name}.validUntil`);
  invariant((value["validUntil"] as number) > (value["validFrom"] as number), `${name} besitzt kein positives Zeitfenster.`);
  invariant(Array.isArray(value["platformLengthsMm"]) && value["platformLengthsMm"].length > 0, `${name}.platformLengthsMm darf nicht leer sein.`);
  for (const [index, length] of value["platformLengthsMm"].entries()) {
    positiveSafeInteger(length, `${name}.platformLengthsMm[${index}]`);
  }
  authorityEnumList(value["electrifications"], AUTHORITY_ELECTRIFICATIONS, `${name}.electrifications`, true);
  authorityEnumList(value["requiredProtection"], AUTHORITY_PROTECTION_SYSTEMS, `${name}.requiredProtection`, false);
  authorityStringList(value["approvedClasses"], `${name}.approvedClasses`, true);
  sha256(value["plannerStateHash"], `${name}.plannerStateHash`);
  sha256(value["conflictCheckHash"], `${name}.conflictCheckHash`);
}

function fleetAuthorityRelease(value: unknown, name: string): asserts value is FleetAuthorityRelease {
  record(value, name);
  const authorityV2 = value["schemaVersion"] === FLEET_AUTHORITY_RELEASE_SCHEMA_V2;
  invariant(
    authorityV2 || value["schemaVersion"] === FLEET_AUTHORITY_RELEASE_SCHEMA,
    `${name} hat ein unbekanntes Schema.`,
  );
  const commonFields = ["schemaVersion", "releaseId", "referenceYear", "assets", "personnelPools", "pathReceipts"] as const;
  exactAuthorityFields(
    value,
    [...commonFields, ...(authorityV2 ? ["economyReleaseId", "economyReleaseSha256"] : [])],
    authorityV2 ? [] : ["economyReleaseId", "economyReleaseSha256"],
    name,
  );
  nonEmptyString(value["releaseId"], `${name}.releaseId`);
  boundedSafeInteger(value["referenceYear"], 65_535, `${name}.referenceYear`);
  invariant((value["referenceYear"] as number) > 0, `${name}.referenceYear ist nicht positiv.`);
  if (Object.hasOwn(value, "economyReleaseId")) nonEmptyString(value["economyReleaseId"], `${name}.economyReleaseId`);
  if (Object.hasOwn(value, "economyReleaseSha256")) sha256(value["economyReleaseSha256"], `${name}.economyReleaseSha256`);
  invariant(Array.isArray(value["assets"]) && value["assets"].length > 0, `${name} besitzt keine Assets.`);
  invariant(Array.isArray(value["personnelPools"]), `${name} besitzt keine Personalpools.`);
  invariant(Array.isArray(value["pathReceipts"]), `${name} besitzt keine Trassenbelege.`);
  const assetIds = new Set<string>();
  const assetNumericIds = new Set<number>();
  for (const [index, rawAsset] of value["assets"].entries()) {
    authorityVehicleAsset(rawAsset, `${name}.assets[${index}]`, authorityV2, value["referenceYear"]);
    const asset = rawAsset as Record<string, unknown>;
    invariant(!assetIds.has(asset["id"] as string), `${name}.assets enthaelt doppelte IDs.`);
    invariant(!assetNumericIds.has(asset["numericId"] as number), `${name}.assets enthaelt doppelte numerische IDs.`);
    assetIds.add(asset["id"] as string);
    assetNumericIds.add(asset["numericId"] as number);
  }
  const poolIds = new Set<string>();
  const poolNumericIds = new Set<number>();
  for (const [index, rawPool] of value["personnelPools"].entries()) {
    authorityPersonnelPool(rawPool, `${name}.personnelPools[${index}]`);
    const pool = rawPool as Record<string, unknown>;
    invariant(!poolIds.has(pool["id"] as string), `${name}.personnelPools enthaelt doppelte IDs.`);
    invariant(!poolNumericIds.has(pool["numericId"] as number), `${name}.personnelPools enthaelt doppelte numerische IDs.`);
    poolIds.add(pool["id"] as string);
    poolNumericIds.add(pool["numericId"] as number);
  }
  const receiptIds = new Set<string>();
  const routeIds = new Set<number>();
  for (const [index, rawReceipt] of value["pathReceipts"].entries()) {
    authorityPathReceipt(rawReceipt, `${name}.pathReceipts[${index}]`);
    const receipt = rawReceipt as Record<string, unknown>;
    invariant(!receiptIds.has(receipt["id"] as string), `${name}.pathReceipts enthaelt doppelte IDs.`);
    invariant(!routeIds.has(receipt["numericRouteId"] as number), `${name}.pathReceipts enthaelt doppelte Routen-IDs.`);
    receiptIds.add(receipt["id"] as string);
    routeIds.add(receipt["numericRouteId"] as number);
  }
  const receiptsById = new Map(
    value["pathReceipts"].map((rawReceipt) => {
      const receipt = rawReceipt as Record<string, unknown>;
      return [receipt["id"] as string, receipt] as const;
    }),
  );
  for (const [index, rawPool] of value["personnelPools"].entries()) {
    const pool = rawPool as Record<string, unknown>;
    for (const receiptId of pool["pathReceiptIds"] as readonly string[]) {
      const receipt = receiptsById.get(receiptId);
      invariant(
        receipt !== undefined,
        `${name}.personnelPools[${index}] verweist auf einen unbekannten Trassenbeleg.`,
      );
      invariant(
        receipt["operatorId"] === pool["operatorId"],
        `${name}.personnelPools[${index}] verweist auf einen Trassenbeleg eines fremden Betreibers.`,
      );
    }
  }
}

/**
 * Gemeinsamer strikt diskriminierter Authority-v1/v2-Vertragsvalidator fuer
 * Server-Lader und die native Runtime-Grenze.
 */
export function validateFleetAuthorityRelease(
  value: unknown,
  name = "Fleet-Authority-Release",
): asserts value is FleetAuthorityRelease {
  fleetAuthorityRelease(value, name);
}

function fleetStateIntents(state: Record<string, unknown>, name: string): void {
  record(state["authorityRelease"], `${name}-Authority-Release`);
  const legacyAuthority = state["authorityRelease"]["schemaVersion"] === FLEET_AUTHORITY_RELEASE_SCHEMA;
  const authorityAssets = state["authorityRelease"]["assets"] as readonly Record<string, unknown>[];
  record(state["formations"], `${name}-Formationen`);
  for (const [id, rawIntent] of Object.entries(state["formations"])) {
    record(rawIntent, `${name}-Formation '${id}'`);
    invariant(rawIntent["id"] === id, `${name}-Formation besitzt eine fremde ID.`);
    if (legacyAuthority) {
      canonicalStringSet(rawIntent["vehicleIds"], `${name}-Formation-Fahrzeuge`);
    } else {
      orderedUniqueStringList(rawIntent["vehicleIds"], `${name}-Formation-Fahrzeuge`);
    }
    nonEmptyString(rawIntent["pathReceiptId"], `${name}-Formation-Trassenbeleg`);
    if (Object.hasOwn(rawIntent, "dynamics")) {
      formationDynamics(rawIntent["dynamics"], `${name}-Formation-Fahrprofil`);
    }
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
  if (!legacyAuthority) {
    invariant(Object.hasOwn(state, "assetHoldings"), `${name}-Authority-v2-Zustand besitzt keine Asset-Halter.`);
  }
  if (Object.hasOwn(state, "assetHoldings")) {
    record(state["assetHoldings"], `${name}-Asset-Halter`);
    if (!legacyAuthority) {
      const authorityIds = new Set(authorityAssets.map((asset) => asset["id"] as string));
      const holdingIds = Object.keys(state["assetHoldings"]);
      invariant(
        holdingIds.length === authorityIds.size && holdingIds.every((id) => authorityIds.has(id)),
        `${name}-Authority-v2-Zustand muss fuer jedes und nur jedes Asset einen Halterzustand enthalten.`,
      );
    }
    for (const [id, rawHolding] of Object.entries(state["assetHoldings"])) {
      record(rawHolding, `${name}-Asset-Halter '${id}'`);
      exactAuthorityFields(
        rawHolding,
        [
          "ownerOperatorId",
          "holderOperatorId",
          "lessorOperatorId",
          "contractId",
          "validUntilS",
          "historyHash",
        ],
        [],
        `${name}-Asset-Halter '${id}'`,
      );
      nonEmptyString(id, `${name}-Asset-ID`);
      nonEmptyString(rawHolding["ownerOperatorId"], `${name}-Asset-Eigentuemer`);
      nonEmptyString(rawHolding["holderOperatorId"], `${name}-Asset-Halter`);
      if (rawHolding["lessorOperatorId"] !== null) nonEmptyString(rawHolding["lessorOperatorId"], `${name}-Asset-Vermieter`);
      if (rawHolding["contractId"] !== null) nonEmptyString(rawHolding["contractId"], `${name}-Asset-Vertrag`);
      if (rawHolding["validUntilS"] !== null) safeInteger(rawHolding["validUntilS"], `${name}-Asset-Mietende`);
      sha256(rawHolding["historyHash"], `${name}-Asset-Historienhash`);
    }
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
    ["formation", "personnel-duty", "path-reservation", "asset-holding"].includes(value["entityKind"] as string),
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
  invariant(["formation", "personnel-duty", "path-reservation", "asset-holding"].includes(value["entityKind"] as string), "Rust-M5-Kommandoergebnis hat eine unbekannte Entitaetsart.");
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

function decodeFleetStateVerification(json: string): FleetWorldStateVerification {
  const value: unknown = parseNativeJson(json, "Rust-M5-Zustandsverifikation");
  record(value, "Rust-M5-Zustandsverifikation");
  invariant(
    value["schemaVersion"] === FLEET_STATE_VERIFICATION_SCHEMA,
    "Rust-M5-Zustandsverifikation hat ein unbekanntes Schema.",
  );
  nonEmptyString(value["worldId"], "Rust-M5-Zustandsverifikation-Welt");
  safeInteger(value["revision"], "Rust-M5-Zustandsverifikation-Revision");
  safeInteger(value["producedAt"], "Rust-M5-Zustandsverifikation-Zustandszeit");
  sha256(value["authorityReleaseHash"], "Rust-M5-Zustandsverifikation-Authority-Release-Hash");
  sha256(value["stateHash"], "Rust-M5-Zustandsverifikation-Zustandshash");
  sha256(value["snapshotHash"], "Rust-M5-Zustandsverifikation-Snapshothash");
  return value as unknown as FleetWorldStateVerification;
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

function decodeOperatingDecision(json: string): OperatingDecisionExplanation {
  const value = parseNativeJson(json, "Rust-Dispositionsentscheidung");
  record(value, "Rust-Dispositionsentscheidung");
  for (const field of ["decision_id", "train_run_id", "program_version"] as const) safeInteger(value[field], `Rust-Dispositionsentscheidung.${field}`);
  for (const field of ["world_id", "operator_id", "program_checksum", "outcome_reason"] as const) nonEmptyString(value[field], `Rust-Dispositionsentscheidung.${field}`);
  sha256(value["program_checksum"], "Rust-Dispositionsentscheidung.program_checksum");
  invariant(value["selected_action"] === null || typeof value["selected_action"] === "string", "Rust-Dispositionsentscheidung besitzt keine gueltige Massnahme.");
  invariant(typeof value["manual_override"] === "boolean", "Rust-Dispositionsentscheidung besitzt keinen Override-Nachweis.");
  record(value["impact"], "Rust-Dispositionsentscheidung.impact");
  return value as OperatingDecisionExplanation;
}

/** Wraps the native ABI. Exported for contract tests; production uses {@link loadOperatingRuntime}. */
export function operatingRuntimeFromAddon(addon: NativeAddon): NativeRuntime {
  return Object.freeze({
    initializeFleet(input: FleetWorldInitialization) {
      invariant(input.schemaVersion === FLEET_INITIALIZE_SCHEMA, "M5-Initialisierung hat ein unbekanntes Schema.");
      nonEmptyString(input.worldId, "M5-Initialisierungswelt");
      safeInteger(input.producedAt, "M5-Initialisierungszeit");
      fleetAuthorityRelease(input.authorityRelease, "M5-Authority-Release");
      if (input.authorityRelease.schemaVersion === FLEET_AUTHORITY_RELEASE_SCHEMA_V2) {
        invariant(
          input.authorityRelease.assets.every((asset) =>
            asset.deliveredAt <= input.producedAt
              && input.producedAt < asset.retiredAt
              && asset.maintenanceDeadlines.every((deadline) => deadline.dueAt > input.producedAt)
          ),
          "M5-Authority-v2 enthaelt am Initialisierungsstichtag ein nicht verfuegbares Asset.",
        );
      }
      const initialized = decodeFleetInitialized(addon.initializeFleetWorld(JSON.stringify(input)));
      invariant(initialized.state.worldId === input.worldId, "Rust-M5-Initialisierung verletzte die Weltisolation.");
      invariant(initialized.state.revision === 0, "Rust-M5-Initialisierung begann nicht bei Revision 0.");
      invariant(initialized.state.producedAt === input.producedAt, "Rust-M5-Initialisierung veraenderte die Zustandszeit.");
      return initialized;
    },
    verifyFleetWorldState(state: NativeFleetWorldState, expectedStateHash: string) {
      record(state, "M5-Zustand");
      invariant(state["schemaVersion"] === FLEET_STATE_SCHEMA, "M5-Zustand hat ein unbekanntes Schema.");
      nonEmptyString(state["worldId"], "M5-Zustandswelt");
      safeInteger(state["revision"], "M5-Zustandsrevision");
      safeInteger(state["producedAt"], "M5-Zustandszeit");
      sha256(state["authorityReleaseHash"], "M5-Authority-Release-Hash");
      fleetAuthorityRelease(state["authorityRelease"], "M5-Zustand-Authority-Release");
      fleetStateIntents(state, "M5-Zustand");
      sha256(expectedStateHash, "M5-erwarteter Zustandshash");
      const verified = decodeFleetStateVerification(
        addon.verifyFleetWorldState(JSON.stringify(state), expectedStateHash),
      );
      invariant(verified.worldId === state.worldId, "Rust-M5-Zustandsverifikation verletzte die Weltisolation.");
      invariant(verified.revision === state.revision, "Rust-M5-Zustandsverifikation lieferte eine fremde Revision.");
      invariant(verified.producedAt === state.producedAt, "Rust-M5-Zustandsverifikation lieferte eine fremde Zustandszeit.");
      invariant(verified.authorityReleaseHash === state.authorityReleaseHash, "Rust-M5-Zustandsverifikation bindet einen fremden Authority-Release-Hash.");
      invariant(verified.stateHash === expectedStateHash, "Rust-M5-Zustandsverifikation bindet nicht den erwarteten Zustandshash.");
      return verified;
    },
    applyFleetCommand(state: NativeFleetWorldState, command: NativeFleetCommand, replayReceipt?: FleetCommandReceipt) {
      record(state, "M5-Zustand");
      fleetAuthorityRelease(state["authorityRelease"], "M5-Zustand-Authority-Release");
      fleetStateIntents(state, "M5-Zustand");
      const canonicalCommand = canonicalizeFleetCommandForState(state, command);
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
      invariant(command.nextTimetableBoundaryS === undefined || (Number.isSafeInteger(command.nextTimetableBoundaryS) && command.nextTimetableBoundaryS >= command.atS), "Runtime-Folgestichtag ist keine sichere Weltsekunde ab dem Betriebsuebergang.");
      const result = decodeTransition(addon.applyOperatingTransition(JSON.stringify(state), JSON.stringify(command)));
      invariant(result.state.worldId === command.worldId, "Rust-Uebergang verletzte die Weltisolation.");
      invariant(result.outcome.lotId === command.lotId, "Rust-Uebergang gehoert zu einem anderen Los.");
      invariant(result.events.every((event) => event.worldId === command.worldId), "Rust-Ereignis verletzte die Weltisolation.");
      return result;
    },
    evaluateDecision(program: Readonly<Record<string, unknown>>, dispatchCase: OperatingDispatchCase) {
      invariant(addon.evaluateOperatingDecision !== undefined, "napi-rs-Addon exportiert evaluateOperatingDecision nicht.");
      const result = decodeOperatingDecision(addon.evaluateOperatingDecision(JSON.stringify(program), JSON.stringify(dispatchCase)));
      invariant(result.world_id === program["world_id"] && result.operator_id === program["operator_id"], "Rust-Dispositionsentscheidung verletzt die Welt- oder EVU-Isolation.");
      invariant(result.decision_id === dispatchCase.decision_id && result.train_run_id === dispatchCase.train_run_id, "Rust-Dispositionsentscheidung gehoert zu einem anderen Fall.");
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
  invariant(typeof required["verifyFleetWorldState"] === "function", "napi-rs-Addon exportiert verifyFleetWorldState nicht.");
  invariant(typeof required["applyFleetCommand"] === "function", "napi-rs-Addon exportiert applyFleetCommand nicht.");
  invariant(typeof required["verifyFleetMobilizationSnapshot"] === "function", "napi-rs-Addon exportiert verifyFleetMobilizationSnapshot nicht.");
  invariant(typeof required["initializeOperatingWorld"] === "function", "napi-rs-Addon exportiert initializeOperatingWorld nicht.");
  invariant(typeof required["applyOperatingTransition"] === "function", "napi-rs-Addon exportiert applyOperatingTransition nicht.");
  invariant(typeof required["evaluateOperatingDecision"] === "function", "napi-rs-Addon exportiert evaluateOperatingDecision nicht.");
  return operatingRuntimeFromAddon(required as unknown as NativeAddon);
}
