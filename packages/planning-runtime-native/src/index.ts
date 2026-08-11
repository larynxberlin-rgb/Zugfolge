import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

import {
  parsePlanningProjection,
  type PlanningProjectionV1,
} from "@zugfolge/planning-projection";

export const PLANNING_COORDINATE_SCHEMA = "planning-coordinate/v1" as const;
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

export interface PlanningCoordinateRequest {
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
  readonly train: {
    readonly numericId: number;
    readonly name: string;
    readonly massKg: number;
    readonly lengthMm: number;
    readonly maximumSpeedKph: number;
    readonly accelerationMmPerS2: number;
    readonly decelerationMmPerS2: number;
  };
}

/** Productive input for one deterministic PlanningRun over a complete window. */
export interface PlanningCoordinateCommand {
  readonly schemaVersion: typeof PLANNING_COORDINATE_SCHEMA;
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
  readonly requests: readonly PlanningCoordinateRequest[];
}

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
      invariant(input.schemaVersion === PLANNING_COORDINATE_SCHEMA, "PlanningRun-Eingang hat ein unbekanntes Schema.");
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
