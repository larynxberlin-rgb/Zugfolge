import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

import {
  parsePlanningProjection,
  type PlanningProjectionV1,
} from "@zugfolge/planning-projection";

export const PLANNING_COORDINATE_SCHEMA_V1 = "planning-coordinate/v1" as const;
export const PLANNING_COORDINATE_SCHEMA = "planning-coordinate/v2" as const;
export const PLANNING_APPLY_ALTERNATIVE_SCHEMA = "planning-apply-alternative/v1" as const;
export const PLANNING_RUNTIME_STATE_SCHEMA = "zugfolge-planning-runtime-state/v1" as const;
export const PLANNING_RUNTIME_RESULT_SCHEMA = "zugfolge-planning-runtime-result/v1" as const;

export interface PlanningCoordinateStation {
  readonly numericId: number;
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly distanceMm: number;
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  readonly stationTrackNumericId: number;
  readonly stationTrackLengthMm: number;
  readonly stationMaximumSpeedKph: number;
}

export interface PlanningCoordinateSegment {
  readonly edgeNumericId: number;
  readonly trackNumericId: number;
  readonly id: string;
  readonly label: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly lengthMm: number;
  readonly maximumSpeedKph: number;
  readonly mainSignalPositionsMm: readonly number[];
  readonly maximumVirtualBlockLengthMm: number;
}

interface PlanningCoordinateTrainBase {
  readonly numericId: number;
  readonly name: string;
  readonly massKg: number;
  readonly lengthMm: number;
  readonly accelerationMmPerS2: number;
  readonly decelerationMmPerS2: number;
}

export interface PlanningCoordinateTrainV1 extends PlanningCoordinateTrainBase {
  /** Legacy-v1: Rust rechnet wie bisher mit `Speed::from_km_h` auf. */
  readonly maximumSpeedKph: number;
}

export interface PlanningCoordinateTrainV2 extends PlanningCoordinateTrainBase {
  /** Serverseitig abgeleitete, verlustfreie Fahrzeug-Vmax in mm/s. */
  readonly maximumSpeedMmps: number;
}

interface PlanningCoordinateRequestBase<TTrain extends PlanningCoordinateTrainBase> {
  readonly requestNumericId: number;
  readonly trainId: string;
  readonly trainCategory: "long-distance" | "suburban" | "regional" | "freight" | "supplementary";
  readonly trainNumber: number;
  readonly originStationId: string;
  readonly destinationStationId: string;
  readonly desiredDepartureS: number;
  readonly operatingDays: "daily" | "workdays" | "weekend";
  readonly stops: readonly {
    readonly stationId: string;
    readonly minimumDwellS: number;
  }[];
  readonly earlierS: number;
  readonly laterS: number;
  readonly stepS: number;
  readonly extraRunningTimeS: number;
  readonly maxOperationalStops: number;
  readonly train: TTrain;
  /** Ausschliesslich serverseitig aus dem gepinnten Release aufgeloest. */
  readonly boundaryWindows?: readonly PlanningCoordinateBoundaryWindow[];
}

export type PlanningCoordinateRequestV1 = PlanningCoordinateRequestBase<PlanningCoordinateTrainV1>;
export type PlanningCoordinateRequestV2 = PlanningCoordinateRequestBase<PlanningCoordinateTrainV2>;
export type PlanningCoordinateRequest = PlanningCoordinateRequestV1 | PlanningCoordinateRequestV2;

export interface PlanningCoordinateBoundaryWindow {
  readonly windowId: string;
  readonly portalId: string;
  readonly direction: "entry" | "exit";
  readonly earliestS: number;
  readonly targetS: number;
  readonly latestS: number;
}

interface PlanningCoordinateCommandBase<
  TSchema extends typeof PLANNING_COORDINATE_SCHEMA_V1 | typeof PLANNING_COORDINATE_SCHEMA,
  TRequest extends PlanningCoordinateRequest,
> {
  readonly schemaVersion: TSchema;
  readonly worldId: string;
  readonly runId: string;
  readonly expectedProjectionRevision: number | null;
  /** Unsigned 64-bit seed encoded as decimal text, never as a JS float. */
  readonly seedWorld: string;
  readonly seedPeriod: number;
  readonly sourceId: string;
  readonly corridorId: string;
  readonly corridorName: string;
  readonly stations: readonly PlanningCoordinateStation[];
  readonly segments: readonly PlanningCoordinateSegment[];
  readonly requests: readonly TRequest[];
}

/** Persistierter Legacy-Eingang; KPH wird ausschließlich in diesem Pfad aufgerundet. */
export type PlanningCoordinateCommandV1 = PlanningCoordinateCommandBase<
  typeof PLANNING_COORDINATE_SCHEMA_V1,
  PlanningCoordinateRequestV1
>;

/** Produktiver Eingang mit verlustfreier, serverautoritativ abgeleiteter mm/s-Vmax. */
export type PlanningCoordinateCommandV2 = PlanningCoordinateCommandBase<
  typeof PLANNING_COORDINATE_SCHEMA,
  PlanningCoordinateRequestV2
>;

/** Productive input for one deterministic PlanningRun over a complete window. */
export type PlanningCoordinateCommand = PlanningCoordinateCommandV1 | PlanningCoordinateCommandV2;

/** Exact payload persisted by game-api for `planning.apply-alternative`. */
export interface PlanningApplyAlternativePayload {
  readonly schemaVersion: typeof PLANNING_APPLY_ALTERNATIVE_SCHEMA;
  readonly projectionRevision: number;
  readonly alternativeId: string;
  readonly conflictId: string;
  readonly trainId: string;
  readonly departureShiftS: number;
}

export interface PlanningRuntimeState {
  readonly schemaVersion: typeof PLANNING_RUNTIME_STATE_SCHEMA;
  readonly worldId: string;
  readonly projectionRevision: number;
  readonly projection: PlanningProjectionV1;
  readonly alternatives: Readonly<Record<string, unknown>>;
  readonly processedCommands: Readonly<Record<string, unknown>>;
}

export interface PlanningRuntimeResult {
  readonly schemaVersion: typeof PLANNING_RUNTIME_RESULT_SCHEMA;
  readonly state: PlanningRuntimeState;
  readonly stateHash: string;
  readonly projection: PlanningProjectionV1;
  readonly idempotentReplay: boolean;
}

export interface PlanningRuntime {
  readonly coordinate: (input: PlanningCoordinateCommand) => PlanningRuntimeResult;
  readonly applyAlternative: (
    state: PlanningRuntimeState,
    commandId: string,
    command: PlanningApplyAlternativePayload,
  ) => PlanningRuntimeResult;
}

export interface PlanningNativeAddon {
  readonly coordinatePlanningRun: (inputJson: string) => unknown;
  readonly applyPlanningAlternative: (
    stateJson: string,
    commandId: string,
    commandJson: string,
  ) => unknown;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value), `${name} ist kein Objekt.`);
}

function safeInteger(value: unknown, name: string): asserts value is number {
  invariant(Number.isSafeInteger(value) && (value as number) >= 0, `${name} ist keine nichtnegative sichere Ganzzahl.`);
}

function positiveSafeInteger(value: unknown, name: string): asserts value is number {
  safeInteger(value, name);
  invariant(value > 0, `${name} ist nicht positiv.`);
}

function nonEmptyString(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string" && value.trim().length > 0, `${name} ist keine nichtleere Zeichenkette.`);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value);
  invariant(required.every((key) => Object.hasOwn(value, key)), `${name} besitzt nicht alle Pflichtfelder.`);
  const allowed = new Set([...required, ...optional]);
  invariant(keys.every((key) => allowed.has(key)), `${name} besitzt unbekannte Felder.`);
}

function validateCoordinateRequest(
  value: unknown,
  schemaVersion: PlanningCoordinateCommand["schemaVersion"],
  name: string,
): void {
  record(value, name);
  exactKeys(value, [
    "requestNumericId",
    "trainId",
    "trainCategory",
    "trainNumber",
    "originStationId",
    "destinationStationId",
    "desiredDepartureS",
    "operatingDays",
    "stops",
    "earlierS",
    "laterS",
    "stepS",
    "extraRunningTimeS",
    "maxOperationalStops",
    "train",
  ], ["boundaryWindows"], name);
  safeInteger(value["requestNumericId"], `${name}.requestNumericId`);
  for (const key of ["trainId", "originStationId", "destinationStationId"] as const) {
    nonEmptyString(value[key], `${name}.${key}`);
  }
  positiveSafeInteger(value["trainNumber"], `${name}.trainNumber`);
  for (const key of [
    "desiredDepartureS",
    "earlierS",
    "laterS",
    "extraRunningTimeS",
    "maxOperationalStops",
  ] as const) {
    safeInteger(value[key], `${name}.${key}`);
  }
  positiveSafeInteger(value["stepS"], `${name}.stepS`);
  invariant(Array.isArray(value["stops"]), `${name}.stops ist keine Liste.`);
  if (Object.hasOwn(value, "boundaryWindows")) {
    invariant(Array.isArray(value["boundaryWindows"]), `${name}.boundaryWindows ist keine Liste.`);
  }

  record(value["train"], `${name}.train`);
  const train = value["train"];
  const speedField = schemaVersion === PLANNING_COORDINATE_SCHEMA_V1
    ? "maximumSpeedKph"
    : "maximumSpeedMmps";
  exactKeys(train, [
    "numericId",
    "name",
    "massKg",
    "lengthMm",
    speedField,
    "accelerationMmPerS2",
    "decelerationMmPerS2",
  ], [], `${name}.train`);
  safeInteger(train["numericId"], `${name}.train.numericId`);
  nonEmptyString(train["name"], `${name}.train.name`);
  for (const key of [
    "massKg",
    "lengthMm",
    speedField,
    "accelerationMmPerS2",
    "decelerationMmPerS2",
  ] as const) {
    positiveSafeInteger(train[key], `${name}.train.${key}`);
  }
}

function validateCoordinateInput(input: PlanningCoordinateCommand): void {
  record(input, "PlanningRun-Eingang");
  invariant(
    input.schemaVersion === PLANNING_COORDINATE_SCHEMA
      || input.schemaVersion === PLANNING_COORDINATE_SCHEMA_V1,
    "PlanningRun-Eingang hat ein unbekanntes Schema.",
  );
  exactKeys(input, [
    "schemaVersion",
    "worldId",
    "runId",
    "expectedProjectionRevision",
    "seedWorld",
    "seedPeriod",
    "sourceId",
    "corridorId",
    "corridorName",
    "stations",
    "segments",
    "requests",
  ], [], "PlanningRun-Eingang");
  for (const key of ["worldId", "runId", "sourceId", "corridorId", "corridorName"] as const) {
    nonEmptyString(input[key], `PlanningRun-Eingang.${key}`);
  }
  invariant(/^[0-9]+$/u.test(input.seedWorld), "PlanningRun-Eingang.seedWorld ist keine u64-Dezimalzahl.");
  safeInteger(input.seedPeriod, "PlanningRun-Eingang.seedPeriod");
  if (input.expectedProjectionRevision !== null) {
    safeInteger(input.expectedProjectionRevision, "PlanningRun-Eingang.expectedProjectionRevision");
  }
  invariant(Array.isArray(input.stations), "PlanningRun-Eingang.stations ist keine Liste.");
  invariant(Array.isArray(input.segments), "PlanningRun-Eingang.segments ist keine Liste.");
  invariant(Array.isArray(input.requests), "PlanningRun-Eingang.requests ist keine Liste.");
  input.requests.forEach((request, index) => {
    validateCoordinateRequest(request, input.schemaVersion, `PlanningRun-Eingang.requests[${index}]`);
  });
}

function nativeResultJson(value: unknown, operation: string): string {
  if (value instanceof Error) throw value;
  invariant(typeof value === "string", `${operation} lieferte weder JSON noch einen JavaScript-Fehler.`);
  return value;
}

function decodeResult(nativeResult: unknown, expectedWorldId: string, operation: string): PlanningRuntimeResult {
  const value: unknown = JSON.parse(nativeResultJson(nativeResult, operation));
  record(value, "Rust-Planning-Ergebnis");
  invariant(value["schemaVersion"] === PLANNING_RUNTIME_RESULT_SCHEMA, "Rust-Planning-Ergebnis hat ein unbekanntes Schema.");
  record(value["state"], "Rust-Planning-Zustand");
  invariant(value["state"]["schemaVersion"] === PLANNING_RUNTIME_STATE_SCHEMA, "Rust-Planning-Zustand hat ein unbekanntes Schema.");
  invariant(value["state"]["worldId"] === expectedWorldId, "Rust-Planning-Zustand verletzt die Weltisolation.");
  safeInteger(value["state"]["projectionRevision"], "Rust-Planning-Revision");
  invariant(typeof value["stateHash"] === "string" && /^[a-f0-9]{64}$/.test(value["stateHash"]), "Rust-Planning-Zustandshash ist kein SHA-256.");
  invariant(typeof value["idempotentReplay"] === "boolean", "Rust-Planning-Ergebnis enthaelt keine Replay-Aussage.");
  const projection = parsePlanningProjection(value["projection"]);
  const stateProjection = parsePlanningProjection(value["state"]["projection"]);
  invariant(projection.worldId === expectedWorldId && stateProjection.worldId === expectedWorldId, "Rust-Planungsprojektion verletzt die Weltisolation.");
  invariant(projection.projectionRevision === value["state"]["projectionRevision"], "Rust-Planungsprojektion und Zustand haben verschiedene Revisionen.");
  invariant(JSON.stringify(projection) === JSON.stringify(stateProjection), "Rust-Planungsprojektion und persistierter Zustand unterscheiden sich.");
  return value as unknown as PlanningRuntimeResult;
}

/** Wraps the real addon ABI; exported only for narrow contract tests. */
export function planningRuntimeFromAddon(addon: PlanningNativeAddon): PlanningRuntime {
  return Object.freeze({
    coordinate(input: PlanningCoordinateCommand) {
      validateCoordinateInput(input);
      const result = decodeResult(
        addon.coordinatePlanningRun(JSON.stringify(input)),
        input.worldId,
        "Rust-PlanningRun",
      );
      const expectedRevision = input.expectedProjectionRevision === null ? 1 : input.expectedProjectionRevision + 1;
      invariant(result.projection.projectionRevision === expectedRevision, "Rust-PlanningRun lieferte keine monotone Fachrevision.");
      invariant(!result.idempotentReplay, "Eine neue PlanningRun-Koordinierung darf kein Apply-Replay behaupten.");
      return result;
    },
    applyAlternative(
      state: PlanningRuntimeState,
      commandId: string,
      command: PlanningApplyAlternativePayload,
    ) {
      invariant(state.worldId.length > 0, "Rust-Planning-Zustand hat keine Welt.");
      invariant(command.schemaVersion === PLANNING_APPLY_ALTERNATIVE_SCHEMA, "Alternativkommando hat ein unbekanntes Schema.");
      invariant(commandId.trim().length > 0, "Alternativkommando hat keine persistente Kommando-ID.");
      const result = decodeResult(
        addon.applyPlanningAlternative(JSON.stringify(state), commandId, JSON.stringify(command)),
        state.worldId,
        "Rust-Planning-Alternative",
      );
      invariant(
        result.idempotentReplay || result.projection.projectionRevision === state.projectionRevision + 1,
        "Rust-Alternative lieferte keine monotone Fachrevision.",
      );
      return result;
    },
  });
}

/** Loads exactly the configured M3 addon; production has no JavaScript fallback. */
export function loadPlanningRuntime(
  addonPath = process.env["ZUGFOLGE_PLANNING_RUNTIME_NATIVE_PATH"],
): PlanningRuntime {
  invariant(addonPath !== undefined && addonPath.length > 0, "ZUGFOLGE_PLANNING_RUNTIME_NATIVE_PATH fehlt.");
  invariant(isAbsolute(addonPath), "ZUGFOLGE_PLANNING_RUNTIME_NATIVE_PATH muss absolut sein.");
  const required: unknown = createRequire(import.meta.url)(addonPath);
  record(required, "M3-napi-rs-Addon");
  invariant(typeof required["coordinatePlanningRun"] === "function", "M3-napi-rs-Addon exportiert coordinatePlanningRun nicht.");
  invariant(typeof required["applyPlanningAlternative"] === "function", "M3-napi-rs-Addon exportiert applyPlanningAlternative nicht.");
  return planningRuntimeFromAddon(required as unknown as PlanningNativeAddon);
}
