import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

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

export type OperationalMovementKind = "train" | "shunting";
export type OperationalDirection = "along" | "against";
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

export interface OperationalTrainInitialization {
  readonly id: string;
  readonly trainNumber: string;
  readonly operatorId: string;
  readonly movementKind: OperationalMovementKind;
  readonly routeVersionId: string;
  readonly formationVersionId: string;
  readonly headRouteMm: number;
  readonly scheduledDepartureMs: number | null;
  readonly publicPassengerStop: boolean;
}

export interface OperationalSimulationInitialization {
  readonly schemaVersion: typeof OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly nowMs: number;
  /** Vollstaendiges, signiertes operatives Release; der Rust-Kern validiert jedes Feld. */
  readonly infraRelease: Readonly<Record<string, unknown>>;
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

export type OperationalSimulationState = Readonly<Record<string, unknown>> & {
  readonly schemaVersion: typeof OPERATIONAL_SIMULATION_STATE_SCHEMA;
  readonly initializationHash: string;
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

export interface OperationalSimulationNativeAddon {
  readonly initializeOperationalSimulation: (inputJson: string) => string;
  readonly restoreOperationalSimulation: (stateJson: string) => string;
  readonly applyOperationalSimulationCommand: (stateJson: string, commandJson: string) => string;
  readonly applyOperationalSimulationCommandAsync?: (
    stateJson: string,
    commandJson: string,
  ) => Promise<string>;
}

export interface OperationalSimulationRuntime {
  readonly initialize: (input: OperationalSimulationInitialization) => OperationalSimulationInitialized;
  readonly restore: (
    state: OperationalSimulationState,
    expectedInitializationHash: string,
  ) => OperationalSimulationRestored;
  readonly apply: (
    state: OperationalSimulationState,
    command: OperationalSimulationCommand,
  ) => Promise<OperationalSimulationResult>;
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
    value["motionGeometry"].every((point, index, points) => index === 0 || point.routeMm > points[index - 1]!.routeMm),
    `${name}.motionGeometry ist nicht streng geordnet.`,
  );
  invariant(
    value["motionSegment"] === null
      ? value["motionGeometry"].length === 0
      : value["motionGeometry"].length >= 2,
    `${name}.motionSegment und motionGeometry widersprechen sich.`,
  );
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
  record(value["state"]["world"], `${name}.state.world`);
  nonEmptyString(value["state"]["world"]["worldId"], `${name}.state.world.worldId`);
  nonEmptyString(value["state"]["world"]["regionId"], `${name}.state.world.regionId`);
  nonEmptyString(value["state"]["world"]["infraReleaseId"], `${name}.state.world.infraReleaseId`);
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
  return value as unknown as T;
}

export function operationalSimulationRuntimeFromAddon(
  addon: OperationalSimulationNativeAddon,
): OperationalSimulationRuntime {
  return Object.freeze({
    initialize(input: OperationalSimulationInitialization) {
      const result = decode<OperationalSimulationInitialized>(
        addon.initializeOperationalSimulation(JSON.stringify(input)),
        OPERATIONAL_SIMULATION_INITIALIZED_SCHEMA,
        "operative Rust-v2-Initialisierung",
      );
      invariant(result.state.world.worldId === input.worldId && result.state.world.regionId === input.regionId, "Operative Initialisierung verletzte Welt- oder Regionsisolation.");
      return result;
    },
    restore(state: OperationalSimulationState, expectedInitializationHash: string) {
      invariant(/^[a-f0-9]{64}$/u.test(expectedInitializationHash), "Erwarteter operativer Initialisierungshash ist ungueltig.");
      const result = decode<OperationalSimulationRestored>(
        addon.restoreOperationalSimulation(JSON.stringify({
          schemaVersion: OPERATIONAL_SIMULATION_RESTORE_SCHEMA,
          expectedInitializationHash,
          state,
        })),
        OPERATIONAL_SIMULATION_RESTORED_SCHEMA,
        "operative Rust-v2-Wiederherstellung",
      );
      invariant(result.state.world.worldId === state.world.worldId && result.state.world.regionId === state.world.regionId, "Operative Wiederherstellung verletzte Welt- oder Regionsisolation.");
      invariant(result.initializationHash === expectedInitializationHash, "Operative Wiederherstellung verletzte die erwartete Initialisierungsbindung.");
      return result;
    },
    async apply(state: OperationalSimulationState, command: OperationalSimulationCommand) {
      invariant(state.world.worldId === command.worldId && state.world.regionId === command.regionId, "Operatives Kommando verletzt Welt- oder Regionsisolation.");
      const stateJson = JSON.stringify(state);
      const commandJson = JSON.stringify(command);
      const raw = addon.applyOperationalSimulationCommandAsync === undefined
        ? addon.applyOperationalSimulationCommand(stateJson, commandJson)
        : await addon.applyOperationalSimulationCommandAsync(stateJson, commandJson);
      const result = decode<OperationalSimulationResult>(
        raw,
        OPERATIONAL_SIMULATION_RESULT_SCHEMA,
        "operatives Rust-v2-Kommando",
      );
      invariant(result.initializationHash === state.initializationHash, "Operatives Kommando wechselte seine Initialisierungsbindung.");
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
  invariant(typeof required["restoreOperationalSimulation"] === "function", "napi-rs-Addon exportiert restoreOperationalSimulation nicht.");
  invariant(typeof required["applyOperationalSimulationCommand"] === "function", "napi-rs-Addon exportiert applyOperationalSimulationCommand nicht.");
  invariant(typeof required["applyOperationalSimulationCommandAsync"] === "function", "napi-rs-Addon exportiert applyOperationalSimulationCommandAsync nicht.");
  return operationalSimulationRuntimeFromAddon(required as unknown as OperationalSimulationNativeAddon);
}
