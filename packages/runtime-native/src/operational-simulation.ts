import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { assertFareControlPolicy, assertOperationalFareControlCommand, type FareControlPolicyV1, type OperationalFareControlCommand } from "./operational-fare-control.js";
export * from "./operational-fare-control.js";
import {
  decodeOperationalDailyRestrictions,
  type OperationalDailyRestrictionsGenerated,
  type OperationalDailyRestrictionsRequest,
} from "./operational-daily-restrictions.js";

export * from "./operational-daily-restrictions.js";

export const OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA =
  "zugfolge-operational-simulation-initialize/v2" as const;
export const OPERATIONAL_SIMULATION_COMMAND_SCHEMA =
  "zugfolge-operational-simulation-command/v2" as const;
export const OPERATIONAL_SIMULATION_STATE_SCHEMA =
  "zugfolge-operational-simulation-state/v2" as const;
export const OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA =
  "zugfolge-operational-simulation-initialized/v2" as const;
export const OPERATIONAL_SIMULATION_RESTORE_SCHEMA =
  "zugfolge-operational-simulation-restore/v2" as const;
export const OPERATIONAL_SIMULATION_RESTORED_SCHEMA =
  "zugfolge-operational-simulation-restored/v2" as const;
export const OPERATIONAL_SIMULATION_RESULT_SCHEMA =
  "zugfolge-operational-simulation-result/v2" as const;
export const OPERATIONAL_SIMULATION_COMMAND_BATCH_SCHEMA =
  "zugfolge-operational-simulation-command-batch/v1" as const;
export const OPERATIONAL_SIMULATION_BATCH_RESULT_SCHEMA =
  "zugfolge-operational-simulation-batch-result/v1" as const;
export const OPERATIONAL_SIMULATION_COMMAND_BATCH_LIMIT = 256 as const;
export const OPERATIONAL_SIMULATION_STATE_JSON_LIMIT_BYTES = 16 * 1024 * 1024;
export const OPERATIONAL_SIMULATION_BATCH_STATE_JSON_LIMIT_BYTES =
  OPERATIONAL_SIMULATION_STATE_JSON_LIMIT_BYTES;
export const OPERATIONAL_SIMULATION_INITIALIZATION_JSON_LIMIT_BYTES = 16 * 1024 * 1024;
export const OPERATIONAL_SIMULATION_RESTORE_JSON_LIMIT_BYTES =
  OPERATIONAL_SIMULATION_STATE_JSON_LIMIT_BYTES + 1024 * 1024;
export const OPERATIONAL_SIMULATION_COMMAND_JSON_LIMIT_BYTES = 8 * 1024 * 1024;
export const OPERATIONAL_SIMULATION_BATCH_JSON_LIMIT_BYTES = 8 * 1024 * 1024;
export const OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA =
  "zugfolge-operational-infrastructure-binding/v2" as const;
export const OPERATIONAL_INFRASTRUCTURE_FILE = "operational-infrastructure-v2.json" as const;
export const OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA =
  "zugfolge-operational-initialization-validation-receipt/v1" as const;
export const OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE = "native-streaming-redb-v1" as const;
export const OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY =
  "zugfolge-protection-mode-selection/conservative-v1" as const;
export const OPERATIONAL_PROTECTION_MODE_SELECTION_EVIDENCE_SCHEMA =
  "zugfolge-protection-mode-selections-evidence/v1" as const;
export const OPERATIONAL_MOVEMENT_CONTINUATIONS_EVIDENCE_SCHEMA =
  "zugfolge-operational-movement-continuations-evidence/v3" as const;
export const OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV =
  "ZUGFOLGE_OPERATIONAL_INFRASTRUCTURE_ROOTS_JSON" as const;
export const OPERATIONAL_TRAIN_NUMBER_PATTERN = "^(?:.*[^0-9])?(?!0{1,5}$)[0-9]{1,5}$" as const;

const OPERATIONAL_TRAIN_NUMBER = new RegExp(OPERATIONAL_TRAIN_NUMBER_PATTERN, "u");
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/** Liefert ausschliesslich den fachlichen, hoechstens fuenfstelligen Nummernteil. */
export function operationalTrainNumberNumericPart(value: unknown): number | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 200
    || value.trim() !== value
    || CONTROL_CHARACTER.test(value)
    || !OPERATIONAL_TRAIN_NUMBER.test(value)
  ) return undefined;
  const digits = /[0-9]{1,5}$/u.exec(value)?.[0];
  if (digits === undefined) return undefined;
  const numericPart = Number(digits);
  return numericPart >= 1 && numericPart <= 99_999 ? numericPart : undefined;
}

/** Harte Welt-/Periodengrenze fuer signierte Programme und interne Ingests. */
export function assertOperationalTrainNumbers(
  trains: readonly Readonly<{ trainNumber: string }>[],
  name = "Operational-v2-Zugprogramm",
): void {
  const numbers = new Set<number>();
  trains.forEach((train, index) => {
    const number = operationalTrainNumberNumericPart(train.trainNumber);
    if (number === undefined) {
      throw new RangeError(`${name}.trains[${index}].trainNumber besitzt keinen numerischen Teil zwischen 1 und 99999.`);
    }
    if (numbers.has(number)) {
      throw new RangeError(`${name} enthaelt die Zugnummer ${number} mehrfach.`);
    }
    numbers.add(number);
  });
}

export type OperationalMovementKind = "train" | "shunting";
export type OperationalDirection = "along" | "against";
export type OperationalProtectionSystem = "etcs-level1" | "etcs-level2" | "lzb" | "pzb";
export type OperationalSignalAspect = "stop" | "proceed" | "shunting-proceed" | "failed";
export type OperationalMotionState = "standing" | "moving" | "safe-stop";

export type OperationalVehicleRestriction =
  | Readonly<{ "power-basis-points": number }>
  | Readonly<{ "maximum-speed": number }>
  | Readonly<{ "service-brake": number }>
  | Readonly<{ "emergency-brake": number }>
  | Readonly<{ "protection-unavailable": string }>
  | Readonly<{ "door-availability-basis-points": number }>
  | "immobilized";

export type OperationalDisruption =
  | Readonly<{ "resource-closed": Readonly<{ resourceId: string }> }>
  | Readonly<{ "speed-restriction": Readonly<{ edgeId: string; maximumSpeedMmps: number }> }>
  | Readonly<{ "signal-failed": Readonly<{ signalId: string }> }>
  | Readonly<{ "switch-failed": Readonly<{ switchId: string }> }>
  | Readonly<{ "track-detection-failed": Readonly<{ resourceId: string }> }>
  | Readonly<{
      "vehicle-restricted": Readonly<{
        vehicleId: string;
        restriction: OperationalVehicleRestriction;
      }>;
    }>;

export interface OperationalDisruptionProjection {
  readonly disruptionId: string;
  readonly effect: OperationalDisruption;
}

export interface OperationalTrackInterval {
  readonly edgeId: string;
  readonly fromMm: number;
  readonly toMm: number;
  readonly direction: OperationalDirection;
}

export interface OperationalRouteGeometryPoint {
  readonly routeMm: number;
  readonly edgeId: string;
  readonly edgeOffsetMm: number;
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  readonly bearingMilliDegrees: number | null;
}

export interface OperationalMotionSegment {
  readonly startedAtMs: number;
  readonly validUntilMs: number;
  readonly startRouteMm: number;
  readonly startSpeedMmps: number;
  readonly accelerationMmps2: number;
  readonly routeVersionId: string;
  readonly authorityEndRouteMm: number;
  readonly segmentEndRouteMm: number;
}

export interface OperationalProjectedTrain {
  readonly trainId: string;
  readonly trainNumber: string;
  readonly operatorId: string;
  readonly movementKind: OperationalMovementKind;
  readonly motionState: OperationalMotionState;
  readonly direction: OperationalDirection;
  readonly routeVersionId: string;
  readonly formationVersionId: string;
  readonly headRouteMm: number;
  readonly tailRouteMm: number;
  readonly speedMmps: number;
  readonly occupiedIntervals: readonly OperationalTrackInterval[];
  readonly occupiedBlocks: readonly string[];
  readonly authorityEndRouteMm: number | null;
  readonly motionSegment: OperationalMotionSegment | null;
  /** Exakter, auch im Stillstand vorhandener Punkt der Zugspitze. */
  readonly headGeometry: OperationalRouteGeometryPoint;
  /** Exakter Zugschlusspunkt; null solange der Zugschluss ausserhalb des Laufwegs liegt. */
  readonly tailGeometry: OperationalRouteGeometryPoint | null;
  /** Autorisierter Kartenverlauf des unveraenderlichen Bewegungsabschnitts. */
  readonly motionGeometry: readonly OperationalRouteGeometryPoint[];
  readonly waitingReason: string | null;
}

export interface OperationalRouteLockProjection {
  readonly id: string;
  readonly templateId: string;
  readonly trainId: string;
  readonly resources: readonly string[];
  readonly releaseAfterTailRouteMm: number;
  readonly lockedAtMs: number;
}

export interface OperationalServiceOutcomeBinding {
  readonly schemaVersion: "zugfolge-operational-service-outcome-binding/v1";
  readonly serviceId: string;
  readonly serviceRunId: string;
  readonly lotId: string;
  readonly serviceDay: string;
  readonly scheduledArrivalMs: number;
  readonly requiredSeats: number | null;
  readonly connectionAssessment: "none-contracted" | "unavailable";
}

export interface OperationalServiceOutcomePolicy {
  readonly schemaVersion: "zugfolge-operational-service-outcome-policy/v1";
  readonly serviceIds: readonly string[];
  readonly vehicleCapacities: readonly Readonly<{ vehicleId: string; seats: number; sourceReference: string }>[];
}

export interface OperationalPassengerStopPlan {
  readonly schemaVersion: "zugfolge-operational-passenger-stop-plan/v1";
  readonly worldId: string;
  readonly infrastructureReleaseId: string;
  readonly timetableReleaseId: string;
  readonly serviceId: string;
  readonly serviceRunId: string;
  readonly trainRunId: string;
  readonly routeVersionId: string;
  readonly sourceBindingHash: string;
  /** Zwei bis 100 eindeutige, exakt gebundene Haltvorkommen. */
  readonly stops: readonly Readonly<{
    stopId: string; stationId: string; stopSequence: number; routeMm: number;
    platformId: string; scheduledArrivalMs: number; scheduledDepartureMs: number; minimumDwellMs: number;
  }>[];
}

export interface OperationalTrainInitialization {
  readonly stopPlan?: OperationalPassengerStopPlan;
  readonly serviceOutcome?: OperationalServiceOutcomeBinding;
  readonly id: string;
  readonly trainNumber: string;
  readonly operatorId: string;
  readonly movementKind: OperationalMovementKind;
  readonly routeVersionId: string;
  readonly formationVersionId: string;
  readonly headRouteMm: number;
  readonly scheduledDepartureMs: number | null;
  readonly publicPassengerStop: boolean;
  /** Signierte Fahrstrassenvorlage; wird nativ validiert, aber nicht im Zugzustand persistiert. */
  readonly dispatchInterlockingRouteId: string;
  /** Kanonische RLE, die jeden RouteLeg genau einmal abdeckt. */
  readonly protectionModeSelectionRuns: readonly Readonly<{
    readonly throughRouteLegIndex: number;
    readonly selectedProtectionSystem: OperationalProtectionSystem;
  }>[];
}

/** Signierter, tagesrelativer Basisgraph; dynamische IDs entstehen erst im Scheduler. */
export interface OperationalMovementContinuationTemplate {
  readonly id: string;
  readonly predecessorTrainId: string;
  /** Signierte Basisroute, gegen die eine qualifizierte Vorgaengerroute nativ aequivalent sein muss. */
  readonly predecessorBaseRouteVersionId: string;
  readonly successorTrainId: string;
  readonly successorDayOffset: 0 | 1;
  /** Explizite DailyPlan-Slotgrenze; unabhaengig von der GTFS-Rohphase. */
  readonly dailyBoundary: boolean;
  readonly minimumDwellMs: number;
  readonly continuity: "same-direction" | "reverse-direction";
  readonly successorFormation: "inherit-predecessor";
}

/** Exakte Materialisierung innerhalb eines atomaren physischen Identitaetswechsels. */
export type OperationalTrainMaterialization = Omit<
  OperationalTrainInitialization,
  "dispatchInterlockingRouteId" | "protectionModeSelectionRuns"
>;

export interface OperationalMovementContinuation {
  readonly id: string;
  readonly predecessorTrainId: string;
  readonly predecessorBaseRouteVersionId: string;
  readonly successor: OperationalTrainMaterialization;
  readonly successorDispatch: OperationalDispatchRequest;
  readonly notBeforeMs: number;
  readonly minimumDwellMs: number;
  readonly continuity: "same-direction" | "reverse-direction";
}

export interface OperationalInfrastructureBinding {
  readonly schemaVersion: typeof OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA;
  readonly infraReleaseId: string;
  readonly file: typeof OPERATIONAL_INFRASTRUCTURE_FILE;
  readonly bytes: number;
  readonly sha256: string;
  readonly stateHash: string;
}

/** Auditierbarer Beleg des nativen Streaming-Gates; keine JavaScript-Nachbildung. */
export interface OperationalInitializationValidationReceipt {
  readonly schemaVersion: typeof OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly initializationHash: string;
  readonly stateHash: string;
  readonly infraRelease: OperationalInfrastructureBinding;
  readonly programTrainCount: number;
  readonly validatedProgramTemplateCount: number;
  readonly validatedRouteVersionCount: number;
  readonly validatedDispatchInterlockingRouteCount: number;
  readonly validatedResourceBindingCount: number;
  readonly validatedFormationBindingCount: number;
  readonly validatedTrainNumberCount: number;
  readonly validatedMovementContinuationCount: number;
  readonly movementContinuationsSha256: string;
  readonly protectionModeSelectionPolicy: typeof OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY;
  readonly validatedProtectionModeSelectionCount: number;
  readonly protectionModeSelectionsSha256: string;
  readonly dynamicTrainCount: 0;
  readonly resourceBindingsValidated: true;
  readonly formationBindingsValidated: true;
  readonly trainNumbersValidated: true;
  readonly protectionModeSelectionsValidated: true;
  readonly validationMode: typeof OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE;
}

export interface OperationalSimulationInitialization {
  readonly fareControlPolicy?: FareControlPolicyV1;
  readonly serviceOutcomePolicy?: OperationalServiceOutcomePolicy;
  readonly schemaVersion: typeof OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly nowMs: number;
  /** null kennzeichnet ein explizit nicht wiederholtes Programm ohne Fortsetzungsgraph. */
  readonly repeatEveryMs: number | null;
  readonly protectionModeSelectionPolicy: typeof OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY;
  /** Kompakte signierte Bindung; die grossen Infrastrukturbytes bleiben ausserhalb von Node. */
  readonly infraRelease: OperationalInfrastructureBinding;
  readonly vehicleTypes: readonly Readonly<{
    vehicleType: Readonly<Record<string, unknown>>;
    powered: boolean;
  }>[];
  readonly vehicles: readonly Readonly<Record<string, unknown>>[];
  readonly formations: readonly Readonly<{
    id: string;
    predecessorId: string | null;
    vehicleIds: readonly string[];
  }>[];
  readonly trains: readonly OperationalTrainInitialization[];
  readonly movementContinuations: readonly OperationalMovementContinuationTemplate[];
}

export interface OperationalDispatchRequest {
  readonly trainId: string;
  readonly interlockingRouteId: string;
  readonly committedRank: number;
  readonly timetableDeviationMs: number;
  readonly passengerImpact: number;
  readonly contractualImpact: number;
  readonly networkImpact: number;
  readonly resourceConsequence: number;
  readonly recoveryRank: number;
  readonly waitingSinceMs: number;
}

export type OperationalSimulationCommandPayload =
  | OperationalFareControlCommand
  | { readonly type: "materialize"; readonly train: OperationalTrainInitialization }
  | { readonly type: "retire"; readonly trainId: string }
  | { readonly type: "advance-to"; readonly atMs: number }
  | { readonly type: "dispatch"; readonly requests: readonly OperationalDispatchRequest[] }
  | { readonly type: "plan-motion"; readonly trainId: string }
  | { readonly type: "safe-stop"; readonly trainId: string; readonly reason: string }
  | {
      readonly type: "change-formation";
      readonly trainId: string;
      readonly formationId: string;
      readonly vehicleIds: readonly string[];
    }
  | { readonly type: "reroute"; readonly trainId: string; readonly routeVersionId: string }
  | {
      readonly type: "queue-movement-continuation";
      readonly continuation: OperationalMovementContinuation;
    }
  | {
      readonly type: "automatic-shunting";
      readonly need: Readonly<{
        id: string;
        trainId: string;
        purpose: "formation" | "locomotive-run-around" | "direction-change" | "stabling" | "supply" | "workshop";
        minimumAuthorityEndRouteMm: number;
      }>;
    }
  | {
      readonly type: "activate-disruption";
      readonly disruptionId: string;
      readonly effect: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "clear-disruption";
      readonly disruptionId: string;
      readonly releaseReference: string;
    };

export interface OperationalSimulationCommand {
  readonly schemaVersion: typeof OPERATIONAL_SIMULATION_COMMAND_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly commandId: string;
  readonly expectedStateHash: string;
  readonly expectedRevision: number;
  readonly expectedPublisherSequence: number;
  readonly command: OperationalSimulationCommandPayload;
}

export interface OperationalSimulationCommandBatchItem {
  readonly commandId: string;
  readonly command: OperationalSimulationCommandPayload;
}

export interface OperationalSimulationCommandBatch {
  readonly schemaVersion: typeof OPERATIONAL_SIMULATION_COMMAND_BATCH_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly expectedStateHash: string;
  readonly expectedRevision: number;
  readonly expectedPublisherSequence: number;
  readonly commands: readonly OperationalSimulationCommandBatchItem[];
}

export type OperationalSimulationState = Readonly<Record<string, unknown>> & {
  readonly schemaVersion: typeof OPERATIONAL_SIMULATION_STATE_SCHEMA;
  readonly initializationHash: string;
  readonly infraRelease: OperationalInfrastructureBinding;
  readonly world: Readonly<Record<string, unknown>> & {
    readonly worldId: string;
    readonly regionId: string;
    readonly infraReleaseId: string;
    readonly nowMs: number;
    readonly commitSequence: number;
    readonly eventSequence: number;
  };
  readonly revision: number;
  readonly publisherSequence: number;
  readonly stateHash: string;
};

export interface OperationalProjection {
  readonly kind: "live-map" | "rzue";
  readonly worldId: string;
  readonly regionId: string;
  readonly infraReleaseId: string;
  readonly commitSequence: number;
  readonly atMs: number;
  readonly staleAfterMs: number;
  readonly trains: readonly OperationalProjectedTrain[];
  readonly routeLocks: readonly OperationalRouteLockProjection[];
  readonly signals: Readonly<Record<string, OperationalSignalAspect>>;
  readonly activeDisruptions: readonly OperationalDisruptionProjection[];
}

export interface OperationalSimulationInitialized {
  readonly schemaVersion: typeof OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA;
  readonly state: OperationalSimulationState;
  readonly initializationHash: string;
  readonly stateHash: string;
  readonly liveMap: OperationalProjection;
  readonly rzue: OperationalProjection;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly validationReceipt: OperationalInitializationValidationReceipt;
}

export interface OperationalSimulationRestored {
  readonly schemaVersion: typeof OPERATIONAL_SIMULATION_RESTORED_SCHEMA;
  readonly state: OperationalSimulationState;
  readonly initializationHash: string;
  readonly stateHash: string;
  readonly liveMap: OperationalProjection;
  readonly rzue: OperationalProjection;
}

export interface OperationalSimulationResult {
  readonly schemaVersion: typeof OPERATIONAL_SIMULATION_RESULT_SCHEMA;
  readonly state: OperationalSimulationState;
  readonly initializationHash: string;
  readonly stateHash: string;
  readonly liveMap: OperationalProjection;
  readonly rzue: OperationalProjection;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly appliedCommandId: string;
  readonly idempotentReplay: boolean;
}

export interface OperationalSimulationBatchCommandResult {
  readonly commandId: string;
  readonly idempotentReplay: boolean;
}

export interface OperationalSimulationBatchEventContext {
  readonly commandIndex: number;
  readonly commandId: string;
  readonly commitSequence: number;
  readonly affectedTrainRunIds: readonly string[];
  readonly disruptionEffectBefore?: OperationalDisruption;
}

export interface OperationalSimulationBatchResult {
  readonly schemaVersion: typeof OPERATIONAL_SIMULATION_BATCH_RESULT_SCHEMA;
  readonly state: OperationalSimulationState;
  readonly initializationHash: string;
  readonly stateHash: string;
  readonly liveMap: OperationalProjection;
  readonly rzue: OperationalProjection;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly commandResults: readonly OperationalSimulationBatchCommandResult[];
  readonly eventContexts: readonly OperationalSimulationBatchEventContext[];
}

export interface OperationalSimulationNativeAddon {
  readonly hashFareControlPolicy?: (policyJson: string) => string;
  readonly generateOperationalDailyRestrictions?: (inputJson: string, infrastructurePath: string) => string;
  readonly hashOperationalSimulationCommand?: (commandJson: string) => string;
  readonly initializeOperationalSimulation: (inputJson: string, infrastructurePath: string) => string;
  readonly restoreOperationalSimulation: (stateJson: string, infrastructurePath: string) => string;
  readonly applyOperationalSimulationCommand: (
    stateJson: string,
    commandJson: string,
    infrastructurePath: string,
  ) => string;
  readonly applyOperationalSimulationCommandAsync?: (
    stateJson: string,
    commandJson: string,
    infrastructurePath: string,
  ) => Promise<string>;
  readonly applyOperationalSimulationCommandBatch?: (
    stateJson: string,
    batchJson: string,
    infrastructurePath: string,
  ) => string;
  readonly applyOperationalSimulationCommandBatchAsync?: (
    stateJson: string,
    batchJson: string,
    infrastructurePath: string,
  ) => Promise<string>;
}

export interface OperationalSimulationRuntime {
  readonly fareControlPolicyHash?: (policy: FareControlPolicyV1) => string;
  readonly dailyRestrictions?: (input: OperationalDailyRestrictionsRequest) => OperationalDailyRestrictionsGenerated;
  readonly commandHash: (command: OperationalSimulationCommandPayload) => string;
  readonly initialize: (input: OperationalSimulationInitialization) => OperationalSimulationInitialized;
  readonly restore: (
    state: OperationalSimulationState,
    expectedInitializationHash: string,
  ) => OperationalSimulationRestored;
  readonly apply: (
    state: OperationalSimulationState,
    command: OperationalSimulationCommand,
  ) => Promise<OperationalSimulationResult>;
  readonly applyBatch: (
    state: OperationalSimulationState,
    batch: OperationalSimulationCommandBatch,
  ) => Promise<OperationalSimulationBatchResult>;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value), `${name} ist kein Objekt.`);
}

function integer(value: unknown, name: string): asserts value is number {
  invariant(Number.isSafeInteger(value), `${name} muss eine sichere Ganzzahl sein.`);
}

function nonNegativeInteger(value: unknown, name: string): asserts value is number {
  integer(value, name);
  invariant(value >= 0, `${name} darf nicht negativ sein.`);
}

function nonEmptyString(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string" && value.length > 0, `${name} darf nicht leer sein.`);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedKeys = new Set(allowed);
  invariant(
    Object.keys(value).every((key) => allowedKeys.has(key)),
    `${name} enthaelt unbekannte Felder.`,
  );
}

const OPERATIONAL_PROTECTION_SYSTEMS = new Set<OperationalProtectionSystem>([
  "etcs-level1",
  "etcs-level2",
  "lzb",
  "pzb",
]);

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

/**
 * Kompakter, sprachuebergreifender Beleg ueber jede train-/route-/leggebundene
 * Moduswahl. Die RLE wird nur in den Hash expandiert und nie materialisiert.
 */
export function operationalProtectionModeSelectionEvidence(
  initialization: OperationalSimulationInitialization,
): Readonly<{ count: number; sha256: string }> {
  invariant(
    initialization.protectionModeSelectionPolicy === OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
    "Operational-v2-Initialisierung besitzt eine unbekannte Zugsicherungs-Auswahlpolicy.",
  );
  const hash = createHash("sha256");
  hash.update(OPERATIONAL_PROTECTION_MODE_SELECTION_EVIDENCE_SCHEMA, "utf8");
  hash.update(Buffer.from([0]));
  let count = 0;
  const ordered = [...initialization.trains].sort((left, right) => {
    const byTrain = Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8"));
    return byTrain !== 0
      ? byTrain
      : Buffer.compare(Buffer.from(left.routeVersionId, "utf8"), Buffer.from(right.routeVersionId, "utf8"));
  });
  for (const train of ordered) {
    nonEmptyString(train.id, "Operational-v2-Zug.id");
    nonEmptyString(train.routeVersionId, `Operational-v2-Zug ${train.id}.routeVersionId`);
    invariant(
      Array.isArray(train.protectionModeSelectionRuns) && train.protectionModeSelectionRuns.length > 0,
      `Operational-v2-Zug ${train.id} besitzt keine Zugsicherungsmodus-Auswahl.`,
    );
    updateLengthPrefixed(hash, train.id);
    updateLengthPrefixed(hash, train.routeVersionId);
    let firstRouteLegIndex = 0;
    let previousSystem: OperationalProtectionSystem | undefined;
    for (const [runIndex, run] of train.protectionModeSelectionRuns.entries()) {
      record(run, `Operational-v2-Zug ${train.id}.protectionModeSelectionRuns[${runIndex}]`);
      exactKeys(
        run,
        ["throughRouteLegIndex", "selectedProtectionSystem"],
        `Operational-v2-Zug ${train.id}.protectionModeSelectionRuns[${runIndex}]`,
      );
      nonNegativeInteger(
        run["throughRouteLegIndex"],
        `Operational-v2-Zug ${train.id}.protectionModeSelectionRuns[${runIndex}].throughRouteLegIndex`,
      );
      invariant(
        run["throughRouteLegIndex"] >= firstRouteLegIndex,
        `Operational-v2-Zug ${train.id} besitzt ueberlappende oder leere Auswahl-Laeufe.`,
      );
      invariant(
        typeof run["selectedProtectionSystem"] === "string"
          && OPERATIONAL_PROTECTION_SYSTEMS.has(run["selectedProtectionSystem"] as OperationalProtectionSystem),
        `Operational-v2-Zug ${train.id} besitzt ein unbekanntes Zugsicherungssystem.`,
      );
      const selectedSystem = run["selectedProtectionSystem"] as OperationalProtectionSystem;
      invariant(
        selectedSystem !== previousSystem,
        `Operational-v2-Zug ${train.id} besitzt nichtkanonische benachbarte Auswahl-Laeufe.`,
      );
      for (let routeLegIndex = firstRouteLegIndex; routeLegIndex <= run["throughRouteLegIndex"]; routeLegIndex += 1) {
        const encodedIndex = Buffer.alloc(8);
        encodedIndex.writeBigUInt64LE(BigInt(routeLegIndex));
        hash.update(encodedIndex);
        updateLengthPrefixed(hash, selectedSystem);
        count += 1;
        invariant(Number.isSafeInteger(count), "Operational-v2-Zugsicherungsbeleg ist zu gross.");
      }
      firstRouteLegIndex = run["throughRouteLegIndex"] + 1;
      invariant(Number.isSafeInteger(firstRouteLegIndex), "Operational-v2-Zugsicherungsbeleg besitzt einen unzaehlbaren Leg-Index.");
      previousSystem = selectedSystem;
    }
  }
  return Object.freeze({ count, sha256: hash.digest("hex") });
}

/** Kanonischer Beleg des vollstaendigen tagesrelativen Fortsetzungsgraphen. */
export function operationalMovementContinuationsEvidence(
  initialization: OperationalSimulationInitialization,
): Readonly<{ count: number; sha256: string }> {
  invariant(
    Array.isArray(initialization.movementContinuations),
    "Operational-v2-Initialisierung besitzt keinen physischen Fortsetzungsgraphen.",
  );
  const hash = createHash("sha256");
  hash.update(OPERATIONAL_MOVEMENT_CONTINUATIONS_EVIDENCE_SCHEMA, "utf8");
  hash.update(Buffer.from([0]));
  const ordered = [...initialization.movementContinuations].sort((left, right) =>
    Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8")));
  for (const [index, continuation] of ordered.entries()) {
    record(continuation, `Operational-v2-Fortsetzung[${index}]`);
    exactKeys(continuation, [
      "id",
      "predecessorTrainId",
      "predecessorBaseRouteVersionId",
      "successorTrainId",
      "successorDayOffset",
      "dailyBoundary",
      "minimumDwellMs",
      "continuity",
      "successorFormation",
    ], `Operational-v2-Fortsetzung[${index}]`);
    nonEmptyString(continuation.id, `Operational-v2-Fortsetzung[${index}].id`);
    nonEmptyString(
      continuation.predecessorTrainId,
      `Operational-v2-Fortsetzung[${index}].predecessorTrainId`,
    );
    nonEmptyString(
      continuation.predecessorBaseRouteVersionId,
      `Operational-v2-Fortsetzung[${index}].predecessorBaseRouteVersionId`,
    );
    nonEmptyString(
      continuation.successorTrainId,
      `Operational-v2-Fortsetzung[${index}].successorTrainId`,
    );
    invariant(
      continuation.successorDayOffset === 0 || continuation.successorDayOffset === 1,
      `Operational-v2-Fortsetzung[${index}].successorDayOffset ist ungueltig.`,
    );
    invariant(
      typeof continuation.dailyBoundary === "boolean",
      `Operational-v2-Fortsetzung[${index}].dailyBoundary ist ungueltig.`,
    );
    nonNegativeInteger(
      continuation.minimumDwellMs,
      `Operational-v2-Fortsetzung[${index}].minimumDwellMs`,
    );
    invariant(
      continuation.continuity === "same-direction"
        || continuation.continuity === "reverse-direction",
      `Operational-v2-Fortsetzung[${index}].continuity ist ungueltig.`,
    );
    invariant(
      continuation.successorFormation === "inherit-predecessor",
      `Operational-v2-Fortsetzung[${index}].successorFormation ist ungueltig.`,
    );
    updateLengthPrefixed(hash, continuation.id);
    updateLengthPrefixed(hash, continuation.predecessorTrainId);
    updateLengthPrefixed(hash, continuation.predecessorBaseRouteVersionId);
    updateLengthPrefixed(hash, continuation.successorTrainId);
    const dayOffset = Buffer.alloc(8);
    dayOffset.writeBigUInt64LE(BigInt(continuation.successorDayOffset));
    hash.update(dayOffset);
    hash.update(Buffer.from([continuation.dailyBoundary ? 1 : 0]));
    const minimumDwellMs = Buffer.alloc(8);
    minimumDwellMs.writeBigInt64LE(BigInt(continuation.minimumDwellMs));
    hash.update(minimumDwellMs);
    updateLengthPrefixed(hash, continuation.continuity);
    updateLengthPrefixed(hash, continuation.successorFormation);
  }
  return Object.freeze({ count: ordered.length, sha256: hash.digest("hex") });
}

function infrastructureBinding(
  value: unknown,
  name: string,
): asserts value is OperationalInfrastructureBinding {
  record(value, name);
  exactKeys(value, ["schemaVersion", "infraReleaseId", "file", "bytes", "sha256", "stateHash"], name);
  invariant(
    value["schemaVersion"] === OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA,
    `${name}.schemaVersion ist ungueltig.`,
  );
  nonEmptyString(value["infraReleaseId"], `${name}.infraReleaseId`);
  invariant(value["file"] === OPERATIONAL_INFRASTRUCTURE_FILE, `${name}.file ist ungueltig.`);
  nonNegativeInteger(value["bytes"], `${name}.bytes`);
  invariant(value["bytes"] > 0, `${name}.bytes muss positiv sein.`);
  invariant(typeof value["sha256"] === "string" && /^[a-f0-9]{64}$/u.test(value["sha256"]), `${name}.sha256 ist ungueltig.`);
  invariant(typeof value["stateHash"] === "string" && /^[a-f0-9]{64}$/u.test(value["stateHash"]), `${name}.stateHash ist ungueltig.`);
  invariant(value["sha256"] !== value["stateHash"], `${name} setzt Byte- und Zustandshash gleich.`);
}

export function operationalInfrastructureBindingsEqual(
  left: unknown,
  right: unknown,
): boolean {
  try {
    infrastructureBinding(left, "linke Operational-v2-Infrastrukturbindung");
    infrastructureBinding(right, "rechte Operational-v2-Infrastrukturbindung");
  } catch {
    return false;
  }
  return left.schemaVersion === right.schemaVersion
    && left.infraReleaseId === right.infraReleaseId
    && left.file === right.file
    && left.bytes === right.bytes
    && left.sha256 === right.sha256
    && left.stateHash === right.stateHash;
}

function initializationValidationReceipt(
  value: unknown,
  initialized: Record<string, unknown>,
  state: Record<string, unknown>,
  world: Record<string, unknown>,
  name: string,
): asserts value is OperationalInitializationValidationReceipt {
  record(value, name);
  exactKeys(value, [
    "schemaVersion", "worldId", "regionId", "initializationHash", "stateHash",
    "infraRelease", "programTrainCount", "validatedProgramTemplateCount",
    "validatedRouteVersionCount", "validatedDispatchInterlockingRouteCount",
    "validatedResourceBindingCount", "validatedFormationBindingCount", "validatedTrainNumberCount",
    "validatedMovementContinuationCount", "movementContinuationsSha256",
    "protectionModeSelectionPolicy", "validatedProtectionModeSelectionCount",
    "protectionModeSelectionsSha256", "protectionModeSelectionsValidated",
    "dynamicTrainCount", "resourceBindingsValidated", "formationBindingsValidated",
    "trainNumbersValidated", "validationMode",
  ], name);
  invariant(
    value["schemaVersion"] === OPERATIONAL_INITIALIZATION_VALIDATION_RECEIPT_SCHEMA,
    `${name}.schemaVersion ist ungueltig.`,
  );
  invariant(value["worldId"] === world["worldId"], `${name} ist an eine fremde Welt gebunden.`);
  invariant(value["regionId"] === world["regionId"], `${name} ist an eine fremde Region gebunden.`);
  invariant(
    value["initializationHash"] === initialized["initializationHash"],
    `${name} besitzt einen fremden Initialisierungshash.`,
  );
  invariant(value["stateHash"] === initialized["stateHash"], `${name} besitzt einen fremden Zustandshash.`);
  infrastructureBinding(value["infraRelease"], `${name}.infraRelease`);
  infrastructureBinding(state["infraRelease"], `${name}.state.infraRelease`);
  invariant(
    operationalInfrastructureBindingsEqual(value["infraRelease"], state["infraRelease"]),
    `${name} besitzt eine fremde Infrastrukturbindung.`,
  );
  const programTrainCount = value["programTrainCount"];
  const validatedProgramTemplateCount = value["validatedProgramTemplateCount"];
  const validatedRouteVersionCount = value["validatedRouteVersionCount"];
  const validatedDispatchInterlockingRouteCount = value["validatedDispatchInterlockingRouteCount"];
  const validatedResourceBindingCount = value["validatedResourceBindingCount"];
  const validatedFormationBindingCount = value["validatedFormationBindingCount"];
  const validatedTrainNumberCount = value["validatedTrainNumberCount"];
  const validatedMovementContinuationCount = value["validatedMovementContinuationCount"];
  const validatedProtectionModeSelectionCount = value["validatedProtectionModeSelectionCount"];
  const dynamicTrainCount = value["dynamicTrainCount"];
  nonNegativeInteger(programTrainCount, `${name}.programTrainCount`);
  nonNegativeInteger(validatedProgramTemplateCount, `${name}.validatedProgramTemplateCount`);
  nonNegativeInteger(validatedRouteVersionCount, `${name}.validatedRouteVersionCount`);
  nonNegativeInteger(
    validatedDispatchInterlockingRouteCount,
    `${name}.validatedDispatchInterlockingRouteCount`,
  );
  nonNegativeInteger(validatedResourceBindingCount, `${name}.validatedResourceBindingCount`);
  nonNegativeInteger(validatedFormationBindingCount, `${name}.validatedFormationBindingCount`);
  nonNegativeInteger(validatedTrainNumberCount, `${name}.validatedTrainNumberCount`);
  nonNegativeInteger(
    validatedMovementContinuationCount,
    `${name}.validatedMovementContinuationCount`,
  );
  invariant(
    typeof value["movementContinuationsSha256"] === "string"
      && /^[a-f0-9]{64}$/u.test(value["movementContinuationsSha256"]),
    `${name}.movementContinuationsSha256 ist ungueltig.`,
  );
  nonNegativeInteger(
    validatedProtectionModeSelectionCount,
    `${name}.validatedProtectionModeSelectionCount`,
  );
  nonNegativeInteger(dynamicTrainCount, `${name}.dynamicTrainCount`);
  invariant(
    validatedProgramTemplateCount === programTrainCount,
    `${name} validierte nicht alle Programmvorlagen.`,
  );
  invariant(
    validatedTrainNumberCount === programTrainCount,
    `${name} validierte nicht alle Zugnummern eindeutig.`,
  );
  invariant(
    validatedMovementContinuationCount === 0
      || validatedMovementContinuationCount === programTrainCount,
    `${name} validierte weder ein einmaliges Programm noch den vollstaendigen physischen Fortsetzungsgraphen.`,
  );
  invariant(
    validatedRouteVersionCount <= validatedProgramTemplateCount,
    `${name} besitzt unplausible Laufwegzahlen.`,
  );
  invariant(
    validatedDispatchInterlockingRouteCount <= validatedProgramTemplateCount,
    `${name} besitzt unplausible Fahrstrassenzahlen.`,
  );
  invariant(
    validatedFormationBindingCount <= validatedProgramTemplateCount,
    `${name} besitzt unplausible Formationszahlen.`,
  );
  if (programTrainCount > 0) {
    invariant(validatedRouteVersionCount > 0, `${name} validierte keine Laufwegversion.`);
    invariant(
      validatedDispatchInterlockingRouteCount > 0,
      `${name} validierte keine disponierbare Fahrstrasse.`,
    );
    invariant(validatedResourceBindingCount > 0, `${name} validierte keine Ressourcenbindung.`);
    invariant(validatedFormationBindingCount > 0, `${name} validierte keine Formationsbindung.`);
    invariant(
      validatedProtectionModeSelectionCount > 0,
      `${name} validierte keine Zugsicherungsmodus-Auswahl.`,
    );
  }
  invariant(dynamicTrainCount === 0, `${name} materialisierte Programmvorlagen beim Weltstart.`);
  invariant(value["resourceBindingsValidated"] === true, `${name} bestaetigt Ressourcenbindungen nicht.`);
  invariant(value["formationBindingsValidated"] === true, `${name} bestaetigt Formationsbindungen nicht.`);
  invariant(value["trainNumbersValidated"] === true, `${name} bestaetigt Zugnummern nicht.`);
  invariant(
    value["protectionModeSelectionPolicy"] === OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY,
    `${name} besitzt eine unbekannte Zugsicherungs-Auswahlpolicy.`,
  );
  invariant(
    typeof value["protectionModeSelectionsSha256"] === "string"
      && /^[a-f0-9]{64}$/u.test(value["protectionModeSelectionsSha256"]),
    `${name}.protectionModeSelectionsSha256 ist ungueltig.`,
  );
  invariant(
    value["protectionModeSelectionsValidated"] === true,
    `${name} bestaetigt Zugsicherungsmodus-Auswahlen nicht.`,
  );
  invariant(
    value["validationMode"] === OPERATIONAL_INFRASTRUCTURE_VALIDATION_MODE,
    `${name}.validationMode ist ungueltig.`,
  );
}

function resolveInfrastructurePath(binding: OperationalInfrastructureBinding): string {
  infrastructureBinding(binding, "Operational-v2-Infrastrukturbindung");
  const configuredRootsJson = process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
  invariant(
    configuredRootsJson !== undefined && configuredRootsJson.length > 0,
    `${OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV} fehlt.`,
  );
  let configuredRoots: unknown;
  try {
    configuredRoots = JSON.parse(configuredRootsJson);
  } catch {
    throw new Error(`${OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV} ist kein gueltiges JSON-Objekt.`);
  }
  record(configuredRoots, OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV);
  invariant(
    Object.keys(configuredRoots).length > 0,
    `${OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV} besitzt keine erlaubte InfraRelease-ID.`,
  );
  for (const [releaseId, configuredReleaseRoot] of Object.entries(configuredRoots)) {
    nonEmptyString(releaseId, `${OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV}-InfraRelease-ID`);
    nonEmptyString(
      configuredReleaseRoot,
      `${OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV}[${JSON.stringify(releaseId)}]`,
    );
    invariant(
      isAbsolute(configuredReleaseRoot),
      `${OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV}[${JSON.stringify(releaseId)}] muss absolut sein.`,
    );
  }
  invariant(
    Object.hasOwn(configuredRoots, binding.infraReleaseId),
    `InfraRelease-ID ${JSON.stringify(binding.infraReleaseId)} besitzt keine erlaubte Operational-v2-Infrastrukturwurzel.`,
  );
  const configuredRoot = configuredRoots[binding.infraReleaseId];
  invariant(typeof configuredRoot === "string", "Operational-v2-Infrastrukturwurzel ist ungueltig.");
  const root = resolve(configuredRoot);
  const rootMetadata = lstatSync(root);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Operational-v2-Infrastrukturwurzel ist kein symlinkfreies Verzeichnis.");
  const realRoot = realpathSync(root);
  invariant(realRoot === root, "Operational-v2-Infrastrukturwurzel darf keinen Symlinkpfad enthalten.");
  const candidate = resolve(root, binding.file);
  invariant(dirname(candidate) === root, "Operational-v2-Infrastrukturdatei verlaesst ihre konfigurierte Wurzel.");
  const candidateMetadata = lstatSync(candidate);
  invariant(candidateMetadata.isFile() && !candidateMetadata.isSymbolicLink(), "Operational-v2-Infrastrukturdatei ist keine regulaere symlinkfreie Datei.");
  invariant(realpathSync(candidate) === candidate, "Operational-v2-Infrastrukturdatei darf keinen Symlinkpfad enthalten.");
  return candidate;
}

function direction(value: unknown, name: string): asserts value is OperationalDirection {
  invariant(value === "along" || value === "against", `${name} besitzt keine gueltige Richtung.`);
}

function geometryPoint(value: unknown, name: string): asserts value is OperationalRouteGeometryPoint {
  record(value, name);
  exactKeys(value, [
    "routeMm", "edgeId", "edgeOffsetMm", "latitudeE7", "longitudeE7",
    "bearingMilliDegrees",
  ], name);
  nonNegativeInteger(value["routeMm"], `${name}.routeMm`);
  nonEmptyString(value["edgeId"], `${name}.edgeId`);
  nonNegativeInteger(value["edgeOffsetMm"], `${name}.edgeOffsetMm`);
  integer(value["latitudeE7"], `${name}.latitudeE7`);
  invariant(value["latitudeE7"] >= -900_000_000 && value["latitudeE7"] <= 900_000_000, `${name}.latitudeE7 liegt ausserhalb der Erde.`);
  integer(value["longitudeE7"], `${name}.longitudeE7`);
  invariant(value["longitudeE7"] >= -1_800_000_000 && value["longitudeE7"] <= 1_800_000_000, `${name}.longitudeE7 liegt ausserhalb der Erde.`);
  if (value["bearingMilliDegrees"] !== null) {
    nonNegativeInteger(value["bearingMilliDegrees"], `${name}.bearingMilliDegrees`);
    invariant(value["bearingMilliDegrees"] < 360_000, `${name}.bearingMilliDegrees ist ungueltig.`);
  }
}

function trackInterval(value: unknown, name: string): asserts value is OperationalTrackInterval {
  record(value, name);
  exactKeys(value, ["edgeId", "fromMm", "toMm", "direction"], name);
  nonEmptyString(value["edgeId"], `${name}.edgeId`);
  nonNegativeInteger(value["fromMm"], `${name}.fromMm`);
  nonNegativeInteger(value["toMm"], `${name}.toMm`);
  invariant(value["fromMm"] < value["toMm"], `${name} ist leer oder umgekehrt.`);
  direction(value["direction"], `${name}.direction`);
}

function motionSegment(value: unknown, name: string): asserts value is OperationalMotionSegment {
  record(value, name);
  exactKeys(value, [
    "startedAtMs", "validUntilMs", "startRouteMm", "startSpeedMmps",
    "accelerationMmps2", "routeVersionId", "authorityEndRouteMm", "segmentEndRouteMm",
  ], name);
  nonNegativeInteger(value["startedAtMs"], `${name}.startedAtMs`);
  nonNegativeInteger(value["validUntilMs"], `${name}.validUntilMs`);
  invariant(value["validUntilMs"] >= value["startedAtMs"], `${name} endet vor seinem Beginn.`);
  nonNegativeInteger(value["startRouteMm"], `${name}.startRouteMm`);
  nonNegativeInteger(value["startSpeedMmps"], `${name}.startSpeedMmps`);
  integer(value["accelerationMmps2"], `${name}.accelerationMmps2`);
  nonEmptyString(value["routeVersionId"], `${name}.routeVersionId`);
  nonNegativeInteger(value["authorityEndRouteMm"], `${name}.authorityEndRouteMm`);
  nonNegativeInteger(value["segmentEndRouteMm"], `${name}.segmentEndRouteMm`);
  invariant(
    value["startRouteMm"] <= value["segmentEndRouteMm"]
      && value["segmentEndRouteMm"] <= value["authorityEndRouteMm"],
    `${name} verletzt Abschnitts- oder Fahrberechtigungsende.`,
  );
}

function projectedTrain(value: unknown, name: string): asserts value is OperationalProjectedTrain {
  record(value, name);
  exactKeys(value, [
    "trainId", "trainNumber", "operatorId", "movementKind", "motionState", "direction",
    "routeVersionId", "formationVersionId", "headRouteMm", "tailRouteMm", "speedMmps",
    "occupiedIntervals", "occupiedBlocks", "authorityEndRouteMm", "motionSegment",
    "headGeometry", "tailGeometry", "motionGeometry", "waitingReason",
  ], name);
  for (const key of ["trainId", "trainNumber", "operatorId", "routeVersionId", "formationVersionId"] as const) {
    nonEmptyString(value[key], `${name}.${key}`);
  }
  invariant(
    operationalTrainNumberNumericPart(value["trainNumber"]) !== undefined,
    `${name}.trainNumber besitzt keinen numerischen Teil zwischen 1 und 99999.`,
  );
  invariant(value["movementKind"] === "train" || value["movementKind"] === "shunting", `${name}.movementKind ist unbekannt.`);
  invariant(
    value["motionState"] === "standing" || value["motionState"] === "moving" || value["motionState"] === "safe-stop",
    `${name}.motionState ist unbekannt.`,
  );
  direction(value["direction"], `${name}.direction`);
  nonNegativeInteger(value["headRouteMm"], `${name}.headRouteMm`);
  integer(value["tailRouteMm"], `${name}.tailRouteMm`);
  invariant(value["tailRouteMm"] <= value["headRouteMm"], `${name} besitzt einen Zugschluss vor der Zugspitze.`);
  nonNegativeInteger(value["speedMmps"], `${name}.speedMmps`);
  invariant(Array.isArray(value["occupiedIntervals"]), `${name}.occupiedIntervals muss eine Liste sein.`);
  value["occupiedIntervals"].forEach((interval, index) => trackInterval(interval, `${name}.occupiedIntervals[${index}]`));
  invariant(Array.isArray(value["occupiedBlocks"]), `${name}.occupiedBlocks muss eine Liste sein.`);
  value["occupiedBlocks"].forEach((block, index) => nonEmptyString(block, `${name}.occupiedBlocks[${index}]`));
  invariant(new Set(value["occupiedBlocks"]).size === value["occupiedBlocks"].length, `${name}.occupiedBlocks enthaelt Duplikate.`);
  if (value["authorityEndRouteMm"] !== null) {
    nonNegativeInteger(value["authorityEndRouteMm"], `${name}.authorityEndRouteMm`);
    invariant(value["authorityEndRouteMm"] >= value["headRouteMm"], `${name} steht hinter seiner Fahrberechtigung.`);
  }
  invariant(
    (value["motionState"] === "moving") === (value["motionSegment"] !== null),
    `${name}.motionState und motionSegment widersprechen sich.`,
  );
  if (value["motionSegment"] !== null) {
    motionSegment(value["motionSegment"], `${name}.motionSegment`);
    invariant(value["motionSegment"].routeVersionId === value["routeVersionId"], `${name}.motionSegment nutzt eine fremde Laufwegversion.`);
    invariant(value["motionSegment"].authorityEndRouteMm === value["authorityEndRouteMm"], `${name}.motionSegment besitzt eine fremde Fahrberechtigung.`);
  }
  geometryPoint(value["headGeometry"], `${name}.headGeometry`);
  invariant(value["headGeometry"].routeMm === value["headRouteMm"], `${name}.headGeometry liegt nicht an der committed Zugspitze.`);
  if (value["tailGeometry"] !== null) {
    geometryPoint(value["tailGeometry"], `${name}.tailGeometry`);
    invariant(value["tailGeometry"].routeMm === value["tailRouteMm"], `${name}.tailGeometry liegt nicht am committed Zugschluss.`);
  }
  invariant(Array.isArray(value["motionGeometry"]), `${name}.motionGeometry muss eine Liste sein.`);
  value["motionGeometry"].forEach((point, index) => geometryPoint(point, `${name}.motionGeometry[${index}]`));
  invariant(
    value["motionGeometry"].every((point, index, points) => {
      const previous = points[index - 1];
      if (previous === undefined) return true;
      if (point.routeMm > previous.routeMm) return point.edgeId === previous.edgeId;
      return point.routeMm === previous.routeMm && point.edgeId !== previous.edgeId
        && point.latitudeE7 === previous.latitudeE7 && point.longitudeE7 === previous.longitudeE7
        && points[index - 2]?.routeMm !== point.routeMm;
    }),
    `${name}.motionGeometry ist nicht lueckenlos gleisgebunden geordnet.`,
  );
  const segment = value["motionSegment"];
  const geometry = value["motionGeometry"];
  const head = value["headGeometry"];
  const constantPosition = segment !== null && segment.startRouteMm === segment.segmentEndRouteMm;
  invariant(segment === null ? geometry.length === 0 : constantPosition
    ? segment.validUntilMs > segment.startedAtMs && geometry.length === 1
      && segment.startRouteMm === head.routeMm
      && (["routeMm", "edgeId", "edgeOffsetMm", "latitudeE7", "longitudeE7", "bearingMilliDegrees"] as const)
        .every((key) => geometry[0]?.[key] === head[key])
    : geometry.length >= 2 && geometry[0]?.routeMm === segment.startRouteMm
      && geometry.at(-1)?.routeMm === segment.segmentEndRouteMm,
  `${name}.motionSegment und motionGeometry widersprechen sich.`);
  if (value["waitingReason"] !== null) nonEmptyString(value["waitingReason"], `${name}.waitingReason`);
}

function routeLock(value: unknown, name: string): asserts value is OperationalRouteLockProjection {
  record(value, name);
  exactKeys(value, ["id", "templateId", "trainId", "resources", "releaseAfterTailRouteMm", "lockedAtMs"], name);
  for (const key of ["id", "templateId", "trainId"] as const) nonEmptyString(value[key], `${name}.${key}`);
  invariant(Array.isArray(value["resources"]) && value["resources"].length > 0, `${name}.resources muss eine nichtleere Liste sein.`);
  value["resources"].forEach((resource, index) => nonEmptyString(resource, `${name}.resources[${index}]`));
  invariant(new Set(value["resources"]).size === value["resources"].length, `${name}.resources enthaelt Duplikate.`);
  nonNegativeInteger(value["releaseAfterTailRouteMm"], `${name}.releaseAfterTailRouteMm`);
  nonNegativeInteger(value["lockedAtMs"], `${name}.lockedAtMs`);
}

function vehicleRestriction(
  value: unknown,
  name: string,
): asserts value is OperationalVehicleRestriction {
  if (value === "immobilized") return;
  record(value, name);
  invariant(Object.keys(value).length === 1, `${name} muss genau eine konkrete Wirkung besitzen.`);
  const [kind] = Object.keys(value);
  switch (kind) {
    case "power-basis-points":
    case "door-availability-basis-points":
      nonNegativeInteger(value[kind], `${name}.${kind}`);
      invariant(value[kind] <= 65_535, `${name}.${kind} liegt ausserhalb des u16-Vertrags.`);
      return;
    case "maximum-speed":
    case "service-brake":
    case "emergency-brake":
      nonNegativeInteger(value[kind], `${name}.${kind}`);
      return;
    case "protection-unavailable":
      nonEmptyString(value[kind], `${name}.${kind}`);
      return;
    default:
      throw new Error(`${name} besitzt eine unbekannte Fahrzeugwirkung.`);
  }
}

function disruptionEffect(value: unknown, name: string): asserts value is OperationalDisruption {
  record(value, name);
  invariant(Object.keys(value).length === 1, `${name} muss genau eine konkrete Wirkung besitzen.`);
  const [kind] = Object.keys(value);
  const detail = value[kind!];
  record(detail, `${name}.${kind}`);
  switch (kind) {
    case "resource-closed":
    case "track-detection-failed":
      exactKeys(detail, ["resourceId"], `${name}.${kind}`);
      nonEmptyString(detail["resourceId"], `${name}.${kind}.resourceId`);
      return;
    case "signal-failed":
      exactKeys(detail, ["signalId"], `${name}.${kind}`);
      nonEmptyString(detail["signalId"], `${name}.${kind}.signalId`);
      return;
    case "switch-failed":
      exactKeys(detail, ["switchId"], `${name}.${kind}`);
      nonEmptyString(detail["switchId"], `${name}.${kind}.switchId`);
      return;
    case "speed-restriction":
      exactKeys(detail, ["edgeId", "maximumSpeedMmps"], `${name}.${kind}`);
      nonEmptyString(detail["edgeId"], `${name}.${kind}.edgeId`);
      nonNegativeInteger(detail["maximumSpeedMmps"], `${name}.${kind}.maximumSpeedMmps`);
      return;
    case "vehicle-restricted":
      exactKeys(detail, ["vehicleId", "restriction"], `${name}.${kind}`);
      nonEmptyString(detail["vehicleId"], `${name}.${kind}.vehicleId`);
      vehicleRestriction(detail["restriction"], `${name}.${kind}.restriction`);
      return;
    default:
      throw new Error(`${name} besitzt eine unbekannte Stoerungswirkung.`);
  }
}

function disruptionProjection(
  value: unknown,
  name: string,
): asserts value is OperationalDisruptionProjection {
  record(value, name);
  exactKeys(value, ["disruptionId", "effect"], name);
  nonEmptyString(value["disruptionId"], `${name}.disruptionId`);
  disruptionEffect(value["effect"], `${name}.effect`);
}

function projection(value: unknown, expectedKind: OperationalProjection["kind"], name: string): asserts value is OperationalProjection {
  record(value, name);
  exactKeys(value, [
    "kind", "worldId", "regionId", "infraReleaseId", "commitSequence", "atMs",
    "staleAfterMs", "trains", "routeLocks", "signals", "activeDisruptions",
  ], name);
  invariant(value["kind"] === expectedKind, `${name}.kind ist ungueltig.`);
  for (const key of ["worldId", "regionId", "infraReleaseId"] as const) nonEmptyString(value[key], `${name}.${key}`);
  nonNegativeInteger(value["commitSequence"], `${name}.commitSequence`);
  nonNegativeInteger(value["atMs"], `${name}.atMs`);
  nonNegativeInteger(value["staleAfterMs"], `${name}.staleAfterMs`);
  invariant(value["staleAfterMs"] >= value["atMs"], `${name} ist bereits bei Veröffentlichung veraltet.`);
  invariant(Array.isArray(value["trains"]), `${name}.trains muss eine Liste sein.`);
  value["trains"].forEach((train, index) => projectedTrain(train, `${name}.trains[${index}]`));
  invariant(new Set(value["trains"].map((train) => train.trainId)).size === value["trains"].length, `${name}.trains enthaelt Duplikate.`);
  invariant(
    new Set(value["trains"].map((train) => operationalTrainNumberNumericPart(train.trainNumber))).size
      === value["trains"].length,
    `${name}.trains enthaelt doppelte Zugnummern.`,
  );
  invariant(Array.isArray(value["routeLocks"]), `${name}.routeLocks muss eine Liste sein.`);
  value["routeLocks"].forEach((lock, index) => routeLock(lock, `${name}.routeLocks[${index}]`));
  invariant(new Set(value["routeLocks"].map((lock) => lock.id)).size === value["routeLocks"].length, `${name}.routeLocks enthaelt Duplikate.`);
  record(value["signals"], `${name}.signals`);
  Object.entries(value["signals"]).forEach(([signalId, aspect]) => {
    nonEmptyString(signalId, `${name}.signals-Signalkennung`);
    invariant(
      aspect === "stop" || aspect === "proceed" || aspect === "shunting-proceed" || aspect === "failed",
      `${name}.signals['${signalId}'] besitzt einen unbekannten Signalbegriff.`,
    );
  });
  invariant(Array.isArray(value["activeDisruptions"]), `${name}.activeDisruptions muss eine Liste sein.`);
  value["activeDisruptions"].forEach((disruption, index) => {
    disruptionProjection(disruption, `${name}.activeDisruptions[${index}]`);
  });
  invariant(
    new Set(value["activeDisruptions"].map((disruption) => disruption.disruptionId)).size
      === value["activeDisruptions"].length,
    `${name}.activeDisruptions enthaelt Duplikate.`,
  );
}

function decode<T>(json: string, schema: string, name: string): T {
  const value: unknown = JSON.parse(json);
  record(value, name);
  invariant(value["schemaVersion"] === schema, `${name} hat ein unbekanntes Schema.`);
  record(value["state"], `${name}.state`);
  invariant(
    Buffer.byteLength(JSON.stringify(value["state"]), "utf8")
      <= OPERATIONAL_SIMULATION_STATE_JSON_LIMIT_BYTES,
    `${name}.state ueberschreitet ${OPERATIONAL_SIMULATION_STATE_JSON_LIMIT_BYTES} UTF-8-Bytes.`,
  );
  invariant(value["state"]["schemaVersion"] === OPERATIONAL_SIMULATION_STATE_SCHEMA, `${name}.state hat ein unbekanntes Schema.`);
  invariant(
    typeof value["initializationHash"] === "string"
      && /^[a-f0-9]{64}$/u.test(value["initializationHash"]),
    `${name}.initializationHash ist ungueltig.`,
  );
  invariant(
    value["state"]["initializationHash"] === value["initializationHash"],
    `${name} besitzt widerspruechliche Initialisierungshashes.`,
  );
  infrastructureBinding(value["state"]["infraRelease"], `${name}.state.infraRelease`);
  record(value["state"]["world"], `${name}.state.world`);
  invariant(
    !("infra" in value["state"]["world"])
      && !("routeVersions" in value["state"]["world"])
      && !("interlockingRoutes" in value["state"]["world"])
      && !("edgeGeometries" in value["state"]["world"]),
    `${name}.state.world enthaelt statische Infrastrukturbytes.`,
  );
  nonEmptyString(value["state"]["world"]["worldId"], `${name}.state.world.worldId`);
  nonEmptyString(value["state"]["world"]["regionId"], `${name}.state.world.regionId`);
  nonEmptyString(value["state"]["world"]["infraReleaseId"], `${name}.state.world.infraReleaseId`);
  invariant(
    value["state"]["world"]["infraReleaseId"] === value["state"]["infraRelease"].infraReleaseId,
    `${name}.state besitzt eine fremde Infrastrukturbindung.`,
  );
  nonNegativeInteger(value["state"]["world"]["nowMs"], `${name}.state.world.nowMs`);
  nonNegativeInteger(value["state"]["world"]["commitSequence"], `${name}.state.world.commitSequence`);
  nonNegativeInteger(value["state"]["world"]["eventSequence"], `${name}.state.world.eventSequence`);
  integer(value["state"]["revision"], `${name}.state.revision`);
  integer(value["state"]["publisherSequence"], `${name}.state.publisherSequence`);
  invariant(typeof value["stateHash"] === "string" && /^[a-f0-9]{64}$/u.test(value["stateHash"]), `${name}.stateHash ist ungueltig.`);
  invariant(value["state"]["stateHash"] === value["stateHash"], `${name} besitzt widerspruechliche Zustandshashes.`);
  invariant(
    value["state"]["world"]["commitSequence"] === value["state"]["revision"]
      && value["state"]["revision"] === value["state"]["publisherSequence"],
    `${name}.state besitzt keine atomare Commitsequenz.`,
  );
  projection(value["liveMap"], "live-map", `${name}.liveMap`);
  projection(value["rzue"], "rzue", `${name}.rzue`);
  const { kind: _liveMapKind, ...liveMapState } = value["liveMap"];
  const { kind: _rzueKind, ...rzueState } = value["rzue"];
  invariant(
    JSON.stringify(liveMapState.activeDisruptions)
      === JSON.stringify(rzueState.activeDisruptions),
    `${name} trennt LiveMap- und RZUE-Stoerungszustand.`,
  );
  invariant(JSON.stringify(liveMapState) === JSON.stringify(rzueState), `${name} trennt LiveMap- und RZUE-Zustand.`);
  const world = value["state"]["world"];
  invariant(
    value["liveMap"].worldId === world["worldId"]
      && value["liveMap"].regionId === world["regionId"]
      && value["liveMap"].infraReleaseId === world["infraReleaseId"]
      && value["liveMap"].commitSequence === world["commitSequence"]
      && value["liveMap"].atMs === world["nowMs"],
    `${name}.liveMap ist nicht an den committed Weltzustand gebunden.`,
  );
  if (schema === OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA) {
    initializationValidationReceipt(
      value["validationReceipt"],
      value,
      value["state"],
      world,
      `${name}.validationReceipt`,
    );
  }
  return value as unknown as T;
}

function validateOperationalCommandBatch(
  state: OperationalSimulationState,
  batch: OperationalSimulationCommandBatch,
): void {
  invariant(
    batch.schemaVersion === OPERATIONAL_SIMULATION_COMMAND_BATCH_SCHEMA,
    "Operative Kommandogruppe hat ein unbekanntes Schema.",
  );
  invariant(
    state.world.worldId === batch.worldId && state.world.regionId === batch.regionId,
    "Operative Kommandogruppe verletzt Welt- oder Regionsisolation.",
  );
  invariant(
    batch.expectedStateHash === state.stateHash
      && batch.expectedRevision === state.revision
      && batch.expectedPublisherSequence === state.publisherSequence,
    "Operative Kommandogruppe besitzt keine exakte CAS-Basis.",
  );
  invariant(
    Array.isArray(batch.commands)
      && batch.commands.length > 0
      && batch.commands.length <= OPERATIONAL_SIMULATION_COMMAND_BATCH_LIMIT,
    `Operative Kommandogruppe muss 1 bis ${OPERATIONAL_SIMULATION_COMMAND_BATCH_LIMIT} Eintraege enthalten.`,
  );
  batch.commands.forEach((item, index) => {
    assertOperationalFareControlCommand(item.command, batch.worldId);
    nonEmptyString(item.commandId, `operative Kommandogruppe.commands[${index}].commandId`);
    record(item.command, `operative Kommandogruppe.commands[${index}].command`);
    if (item.command.type === "materialize") {
      assertOperationalTrainNumbers(
        [item.command.train],
        `operative Kommandogruppe.commands[${index}].command`,
      );
    }
  });
}

function validateOperationalBatchResult(
  result: OperationalSimulationBatchResult,
  state: OperationalSimulationState,
  batch: OperationalSimulationCommandBatch,
): void {
  invariant(
    result.initializationHash === state.initializationHash,
    "Operative Kommandogruppe wechselte ihre Initialisierungsbindung.",
  );
  invariant(
    operationalInfrastructureBindingsEqual(result.state.infraRelease, state.infraRelease),
    "Operative Kommandogruppe wechselte die Infrastrukturbindung.",
  );
  invariant(
    result.state.world.worldId === batch.worldId && result.state.world.regionId === batch.regionId,
    "Operative Kommandogruppe quittierte eine fremde Welt oder Region.",
  );
  invariant(
    Array.isArray(result.commandResults)
      && result.commandResults.length === batch.commands.length,
    "Operative Runtime quittierte nicht jedes Batchkommando genau einmal.",
  );

  const commitSequenceAtIndex: number[] = [];
  let appliedCount = 0;
  result.commandResults.forEach((commandResult, index) => {
    record(commandResult, `operatives Batchresultat.commandResults[${index}]`);
    exactKeys(
      commandResult,
      ["commandId", "idempotentReplay"],
      `operatives Batchresultat.commandResults[${index}]`,
    );
    invariant(
      commandResult["commandId"] === batch.commands[index]!.commandId,
      "Operative Runtime vertauschte oder ersetzte eine Batch-Kommando-ID.",
    );
    invariant(
      typeof commandResult["idempotentReplay"] === "boolean",
      `operatives Batchresultat.commandResults[${index}].idempotentReplay ist kein Boolean.`,
    );
    if (!commandResult["idempotentReplay"]) appliedCount += 1;
    commitSequenceAtIndex.push(state.world.commitSequence + appliedCount);
  });
  const expectedRevision = state.revision + appliedCount;
  const expectedPublisherSequence = state.publisherSequence + appliedCount;
  invariant(
    Number.isSafeInteger(expectedRevision) && Number.isSafeInteger(expectedPublisherSequence),
    "Operative Kommandogruppe ueberlaeuft ihre Sequenz.",
  );
  invariant(
    result.state.revision === expectedRevision
      && result.state.publisherSequence === expectedPublisherSequence
      && result.state.world.commitSequence === state.world.commitSequence + appliedCount,
    "Operative Runtime erzeugte in der Kommandogruppe eine Sequenzluecke.",
  );
  if (appliedCount === 0) {
    invariant(
      result.stateHash === state.stateHash,
      "Eine reine idempotente Kommandogruppe veraenderte den Zustandshash.",
    );
  }

  invariant(Array.isArray(result.events), "Operatives Batchresultat.events muss eine Liste sein.");
  result.events.forEach((event, index) => record(event, `operatives Batchresultat.events[${index}]`));
  invariant(
    Array.isArray(result.eventContexts),
    "Operatives Batchresultat.eventContexts muss eine Liste sein.",
  );
  const contextIndexes = new Set<number>();
  result.eventContexts.forEach((context, index) => {
    record(context, `operatives Batchresultat.eventContexts[${index}]`);
    exactKeys(
      context,
      ["commandIndex", "commandId", "commitSequence", "affectedTrainRunIds", "disruptionEffectBefore"],
      `operatives Batchresultat.eventContexts[${index}]`,
    );
    nonNegativeInteger(context["commandIndex"], `operatives Batchresultat.eventContexts[${index}].commandIndex`);
    invariant(
      context["commandIndex"] < batch.commands.length && !contextIndexes.has(context["commandIndex"]),
      "Operatives Batchresultat besitzt einen fremden oder doppelten Ereigniskontext.",
    );
    contextIndexes.add(context["commandIndex"]);
    const commandIndex = context["commandIndex"];
    const command = batch.commands[commandIndex]!;
    invariant(context["commandId"] === command.commandId, "Operativer Ereigniskontext besitzt eine fremde Kommando-ID.");
    invariant(
      result.commandResults[commandIndex]!.idempotentReplay === false,
      "Idempotenter Replay erzeugte einen operativen Ereigniskontext.",
    );
    invariant(
      context["commitSequence"] === commitSequenceAtIndex[commandIndex],
      "Operativer Ereigniskontext besitzt eine fremde Commitsequenz.",
    );
    invariant(
      command.command.type === "activate-disruption" || command.command.type === "clear-disruption",
      "Operativer Stoerungsereigniskontext besitzt kein Stoerungskommando.",
    );
    invariant(
      Array.isArray(context["affectedTrainRunIds"]),
      `operatives Batchresultat.eventContexts[${index}].affectedTrainRunIds muss eine Liste sein.`,
    );
    context["affectedTrainRunIds"].forEach((trainId, trainIndex) => {
      nonEmptyString(
        trainId,
        `operatives Batchresultat.eventContexts[${index}].affectedTrainRunIds[${trainIndex}]`,
      );
    });
    invariant(
      new Set(context["affectedTrainRunIds"]).size === context["affectedTrainRunIds"].length,
      "Operativer Ereigniskontext enthaelt doppelte betroffene Zuglaeufe.",
    );
    if (command.command.type === "clear-disruption") {
      disruptionEffect(
        context["disruptionEffectBefore"],
        `operatives Batchresultat.eventContexts[${index}].disruptionEffectBefore`,
      );
    } else {
      invariant(
        !("disruptionEffectBefore" in context),
        "Aktivierungskontext darf keine vorherige Stoerungswirkung besitzen.",
      );
    }
  });
  result.commandResults.forEach((commandResult, index) => {
    const type = batch.commands[index]!.command.type;
    if (!commandResult.idempotentReplay && (type === "activate-disruption" || type === "clear-disruption")) {
      invariant(contextIndexes.has(index), "Angewandtes Stoerungskommando besitzt keinen Ereigniskontext.");
    }
  });
}

export function operationalSimulationRuntimeFromAddon(
  addon: OperationalSimulationNativeAddon,
): OperationalSimulationRuntime {
  return Object.freeze({
    fareControlPolicyHash(policy: FareControlPolicyV1) {
      assertFareControlPolicy({ ...policy, contentHash: "0".repeat(64) });
      invariant(typeof addon.hashFareControlPolicy === "function", "napi-rs-Addon exportiert hashFareControlPolicy nicht.");
      const json = JSON.stringify(policy);
      invariant(Buffer.byteLength(json, "utf8") <= OPERATIONAL_SIMULATION_COMMAND_JSON_LIMIT_BYTES, "Kontrollhaltpolicy überschreitet das Transportbudget.");
      const hash = addon.hashFareControlPolicy(json);
      invariant(/^[a-f0-9]{64}$/u.test(hash), "Nativer Kontrollhaltpolicyhash ist ungültig.");
      return hash;
    },
    dailyRestrictions(input: OperationalDailyRestrictionsRequest) {
      invariant(typeof addon.generateOperationalDailyRestrictions === "function",
        "napi-rs-Addon exportiert generateOperationalDailyRestrictions nicht.");
      const inputJson = JSON.stringify(input);
      invariant(Buffer.byteLength(inputJson, "utf8") <= OPERATIONAL_SIMULATION_INITIALIZATION_JSON_LIMIT_BYTES,
        "Operativer La-Auftrag ueberschreitet das Transportbudget.");
      return decodeOperationalDailyRestrictions(
        addon.generateOperationalDailyRestrictions(inputJson, resolveInfrastructurePath(input.infraRelease)),
        input,
      );
    },
    commandHash(command: OperationalSimulationCommandPayload) {
      assertOperationalFareControlCommand(command);
      invariant(
        typeof addon.hashOperationalSimulationCommand === "function",
        "napi-rs-Addon exportiert hashOperationalSimulationCommand nicht.",
      );
      const hash = addon.hashOperationalSimulationCommand(JSON.stringify(command));
      invariant(/^[a-f0-9]{64}$/u.test(hash), "Nativer operativer Kommandohash ist ungueltig.");
      return hash;
    },
    initialize(input: OperationalSimulationInitialization) {
      if (input.fareControlPolicy !== undefined) assertFareControlPolicy(input.fareControlPolicy, input.worldId);
      assertOperationalTrainNumbers(input.trains, "operative Rust-v2-Initialisierung");
      invariant(
        (input.repeatEveryMs === null && input.movementContinuations.length === 0)
          || (
            Number.isSafeInteger(input.repeatEveryMs)
            && (input.repeatEveryMs as number) > 0
            && (
              input.trains.length === 0
              || input.movementContinuations.length === input.trains.length
            )
          ),
        "Operative Initialisierung bindet Wiederholung und physischen Fortsetzungsgraphen nicht eindeutig.",
      );
      const protectionModeSelectionEvidence = operationalProtectionModeSelectionEvidence(input);
      const movementContinuationsEvidence = operationalMovementContinuationsEvidence(input);
      const infrastructurePath = resolveInfrastructurePath(input.infraRelease);
      const inputJson = JSON.stringify(input);
      invariant(
        Buffer.byteLength(inputJson, "utf8") <= OPERATIONAL_SIMULATION_INITIALIZATION_JSON_LIMIT_BYTES,
        `Operative Initialisierung ueberschreitet ${OPERATIONAL_SIMULATION_INITIALIZATION_JSON_LIMIT_BYTES} UTF-8-Bytes.`,
      );
      const result = decode<OperationalSimulationInitialized>(
        addon.initializeOperationalSimulation(inputJson, infrastructurePath),
        OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
        "operative Rust-v2-Initialisierung",
      );
      invariant(result.state.world.worldId === input.worldId && result.state.world.regionId === input.regionId, "Operative Initialisierung verletzte Welt- oder Regionsisolation.");
      invariant(operationalInfrastructureBindingsEqual(result.state.infraRelease, input.infraRelease), "Operative Initialisierung wechselte die Infrastrukturbindung.");
      invariant(
        result.validationReceipt.protectionModeSelectionPolicy === input.protectionModeSelectionPolicy
          && result.validationReceipt.validatedProtectionModeSelectionCount === protectionModeSelectionEvidence.count
          && result.validationReceipt.protectionModeSelectionsSha256 === protectionModeSelectionEvidence.sha256
          && result.validationReceipt.protectionModeSelectionsValidated === true,
        "Nativer Initialisierungsbeleg bindet die signierte Zugsicherungsmodus-Auswahl nicht.",
      );
      invariant(
        result.validationReceipt.validatedMovementContinuationCount
          === movementContinuationsEvidence.count
          && result.validationReceipt.movementContinuationsSha256
            === movementContinuationsEvidence.sha256,
        "Nativer Initialisierungsbeleg bindet den physischen Fortsetzungsgraphen nicht.",
      );
      return result;
    },
    restore(state: OperationalSimulationState, expectedInitializationHash: string) {
      invariant(/^[a-f0-9]{64}$/u.test(expectedInitializationHash), "Erwarteter operativer Initialisierungshash ist ungueltig.");
      const infrastructurePath = resolveInfrastructurePath(state.infraRelease);
      const stateBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
      invariant(
        stateBytes <= OPERATIONAL_SIMULATION_STATE_JSON_LIMIT_BYTES,
        `Operativer Restore-Zustand ueberschreitet ${OPERATIONAL_SIMULATION_STATE_JSON_LIMIT_BYTES} UTF-8-Bytes.`,
      );
      const restoreJson = JSON.stringify({
        schemaVersion: OPERATIONAL_SIMULATION_RESTORE_SCHEMA,
        expectedInitializationHash,
        state,
      });
      invariant(
        Buffer.byteLength(restoreJson, "utf8") <= OPERATIONAL_SIMULATION_RESTORE_JSON_LIMIT_BYTES,
        `Operative Wiederherstellung ueberschreitet ${OPERATIONAL_SIMULATION_RESTORE_JSON_LIMIT_BYTES} UTF-8-Bytes.`,
      );
      const result = decode<OperationalSimulationRestored>(
        addon.restoreOperationalSimulation(restoreJson, infrastructurePath),
        OPERATIONAL_SIMULATION_RESTORED_SCHEMA,
        "operative Rust-v2-Wiederherstellung",
      );
      invariant(result.state.world.worldId === state.world.worldId && result.state.world.regionId === state.world.regionId, "Operative Wiederherstellung verletzte Welt- oder Regionsisolation.");
      invariant(result.initializationHash === expectedInitializationHash, "Operative Wiederherstellung verletzte die erwartete Initialisierungsbindung.");
      invariant(operationalInfrastructureBindingsEqual(result.state.infraRelease, state.infraRelease), "Operative Wiederherstellung wechselte die Infrastrukturbindung.");
      return result;
    },
    async apply(state: OperationalSimulationState, command: OperationalSimulationCommand) {
      assertOperationalFareControlCommand(command.command, command.worldId);
      invariant(state.world.worldId === command.worldId && state.world.regionId === command.regionId, "Operatives Kommando verletzt Welt- oder Regionsisolation.");
      if (command.command.type === "materialize") {
        assertOperationalTrainNumbers([command.command.train], "operatives Rust-v2-Materialisierungskommando");
      }
      const infrastructurePath = resolveInfrastructurePath(state.infraRelease);
      const stateJson = JSON.stringify(state);
      const commandJson = JSON.stringify(command);
      invariant(
        Buffer.byteLength(stateJson, "utf8") <= OPERATIONAL_SIMULATION_STATE_JSON_LIMIT_BYTES,
        `Operativer Kommandozustand ueberschreitet ${OPERATIONAL_SIMULATION_STATE_JSON_LIMIT_BYTES} UTF-8-Bytes.`,
      );
      invariant(
        Buffer.byteLength(commandJson, "utf8") <= OPERATIONAL_SIMULATION_COMMAND_JSON_LIMIT_BYTES,
        `Operatives Kommando ueberschreitet ${OPERATIONAL_SIMULATION_COMMAND_JSON_LIMIT_BYTES} UTF-8-Bytes.`,
      );
      const raw = addon.applyOperationalSimulationCommandAsync === undefined
        ? addon.applyOperationalSimulationCommand(stateJson, commandJson, infrastructurePath)
        : await addon.applyOperationalSimulationCommandAsync(stateJson, commandJson, infrastructurePath);
      const result = decode<OperationalSimulationResult>(
        raw,
        OPERATIONAL_SIMULATION_RESULT_SCHEMA,
        "operatives Rust-v2-Kommando",
      );
      invariant(result.initializationHash === state.initializationHash, "Operatives Kommando wechselte seine Initialisierungsbindung.");
      invariant(operationalInfrastructureBindingsEqual(result.state.infraRelease, state.infraRelease), "Operatives Kommando wechselte die Infrastrukturbindung.");
      invariant(result.appliedCommandId === command.commandId, "Operative Runtime quittierte eine fremde Kommando-ID.");
      if (!result.idempotentReplay) {
        invariant(result.state.revision === command.expectedRevision + 1, "Operative Runtime erzeugte eine Revisionsluecke.");
        invariant(result.state.publisherSequence === command.expectedPublisherSequence + 1, "Operative Runtime erzeugte eine Publisherluecke.");
        invariant(result.state.world.commitSequence === command.expectedRevision + 1, "Operative Runtime erzeugte keine atomare Commitsequenz.");
      } else {
        invariant(result.state.world.commitSequence === state.world.commitSequence, "Idempotenter Replay veraenderte die Commitsequenz.");
      }
      return result;
    },
    async applyBatch(
      state: OperationalSimulationState,
      batch: OperationalSimulationCommandBatch,
    ) {
      validateOperationalCommandBatch(state, batch);
      invariant(
        typeof addon.applyOperationalSimulationCommandBatch === "function"
          || typeof addon.applyOperationalSimulationCommandBatchAsync === "function",
        "napi-rs-Addon exportiert applyOperationalSimulationCommandBatch nicht.",
      );
      const infrastructurePath = resolveInfrastructurePath(state.infraRelease);
      const stateJson = JSON.stringify(state);
      const batchJson = JSON.stringify(batch);
      invariant(
        Buffer.byteLength(stateJson, "utf8") <= OPERATIONAL_SIMULATION_BATCH_STATE_JSON_LIMIT_BYTES,
        `Operativer Zustand ueberschreitet ${OPERATIONAL_SIMULATION_BATCH_STATE_JSON_LIMIT_BYTES} UTF-8-Bytes.`,
      );
      invariant(
        Buffer.byteLength(batchJson, "utf8") <= OPERATIONAL_SIMULATION_BATCH_JSON_LIMIT_BYTES,
        `Operative Kommandogruppe ueberschreitet ${OPERATIONAL_SIMULATION_BATCH_JSON_LIMIT_BYTES} UTF-8-Bytes.`,
      );
      const raw = addon.applyOperationalSimulationCommandBatchAsync === undefined
        ? addon.applyOperationalSimulationCommandBatch!(stateJson, batchJson, infrastructurePath)
        : await addon.applyOperationalSimulationCommandBatchAsync(stateJson, batchJson, infrastructurePath);
      const result = decode<OperationalSimulationBatchResult>(
        raw,
        OPERATIONAL_SIMULATION_BATCH_RESULT_SCHEMA,
        "operative Rust-v2-Kommandogruppe",
      );
      validateOperationalBatchResult(result, state, batch);
      return result;
    },
  });
}

/** Laedt ausschliesslich die native v2-ABI; einen JavaScript-Fallback gibt es nicht. */
export function loadOperationalSimulationRuntime(
  addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"],
): OperationalSimulationRuntime {
  invariant(addonPath !== undefined && addonPath.length > 0, "ZUGFOLGE_RUNTIME_NATIVE_PATH fehlt.");
  invariant(isAbsolute(addonPath), "ZUGFOLGE_RUNTIME_NATIVE_PATH muss absolut sein.");
  const required: unknown = createRequire(import.meta.url)(addonPath);
  record(required, "napi-rs-Addon");
  invariant(typeof required["initializeOperationalSimulation"] === "function", "napi-rs-Addon exportiert initializeOperationalSimulation nicht.");
  invariant(typeof required["hashOperationalSimulationCommand"] === "function", "napi-rs-Addon exportiert hashOperationalSimulationCommand nicht.");
  invariant(typeof required["restoreOperationalSimulation"] === "function", "napi-rs-Addon exportiert restoreOperationalSimulation nicht.");
  invariant(typeof required["applyOperationalSimulationCommand"] === "function", "napi-rs-Addon exportiert applyOperationalSimulationCommand nicht.");
  invariant(typeof required["applyOperationalSimulationCommandAsync"] === "function", "napi-rs-Addon exportiert applyOperationalSimulationCommandAsync nicht.");
  invariant(typeof required["applyOperationalSimulationCommandBatch"] === "function", "napi-rs-Addon exportiert applyOperationalSimulationCommandBatch nicht.");
  invariant(typeof required["applyOperationalSimulationCommandBatchAsync"] === "function", "napi-rs-Addon exportiert applyOperationalSimulationCommandBatchAsync nicht.");
  return operationalSimulationRuntimeFromAddon(required as unknown as OperationalSimulationNativeAddon);
}
