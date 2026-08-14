import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

export const REGIONAL_SIMULATION_INITIALIZE_SCHEMA =
  "zugfolge-regional-simulation-initialize/v1" as const;
export const REGIONAL_SIMULATION_COMMAND_SCHEMA =
  "zugfolge-regional-simulation-command/v1" as const;
export const REGIONAL_SIMULATION_COMMAND_BATCH_SCHEMA =
  "zugfolge-regional-simulation-command-batch/v1" as const;
export const REGIONAL_SIMULATION_STATE_SCHEMA =
  "zugfolge-regional-simulation-state/v1" as const;
export const REGIONAL_SIMULATION_INITIALIZED_SCHEMA =
  "zugfolge-regional-simulation-initialized/v1" as const;
export const REGIONAL_SIMULATION_RESTORED_SCHEMA =
  "zugfolge-regional-simulation-restored/v1" as const;
export const REGIONAL_SIMULATION_RESULT_SCHEMA =
  "zugfolge-regional-simulation-result/v1" as const;
export const REGIONAL_SIMULATION_BATCH_RESULT_SCHEMA =
  "zugfolge-regional-simulation-batch-result/v1" as const;
export const REGIONAL_SIMULATION_MAX_BATCH_COMMANDS = 4_096;
export const REGIONAL_LIVEMAP_SNAPSHOT_SCHEMA =
  "zugfolge-regional-livemap-snapshot/v1" as const;
export const REGIONAL_LIVEMAP_DELTA_SCHEMA =
  "zugfolge-regional-livemap-delta/v1" as const;

export type RegionalTrainCategory =
  | "regional"
  | "long-distance"
  | "freight"
  | "empty-stock"
  | "engineering";

export interface RegionalWaypointInput {
  readonly operatingPoint: string;
  readonly positionMm: number;
  readonly arrivalS: number;
  readonly minimumDwellSeconds: number;
  readonly departureS: number;
}

export interface RegionalTrainInput {
  readonly trainRunId: string;
  /** Unveränderliche Basisfahrt für wiederholte Runtime-Instanzen. */
  readonly baseTrainRunId?: string;
  readonly operator: string;
  readonly trainNumber: string;
  readonly category: RegionalTrainCategory;
  readonly route: readonly RegionalWaypointInput[];
}

export interface RegionalSimulationInitialization {
  readonly schemaVersion: typeof REGIONAL_SIMULATION_INITIALIZE_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly materializationWindowHours: number;
  readonly nowS: number;
  readonly trains: readonly RegionalTrainInput[];
}

export type RegionalSimulationCommandPayload =
  | { readonly type: "materialize"; readonly train: RegionalTrainInput }
  | { readonly type: "advance-to"; readonly atS: number }
  | {
      readonly type: "add-delay";
      readonly trainRunId: string;
      readonly seconds: number;
    }
  | { readonly type: "dematerialize-before"; readonly beforeS: number }
  | {
      readonly type: "register-disruption";
      readonly disruption: {
        readonly disruptionId: string;
        readonly kind: "planned" | "unplanned";
        readonly publishedAtS: number;
        readonly startsAtS: number;
        readonly validUntilS: number;
        readonly positionMm: number;
        readonly causeCode: number;
        readonly fineCauseId: string;
        readonly effect: "closure" | "single-track" | "speed-restriction" | "platform-change" | "traffic-hold" | "route-deviation" | "vehicle-restriction" | "platform-usable-length";
        readonly affectedResource: string;
        readonly affectedTrainRunIds: readonly string[];
        readonly delaySeconds: number;
      };
    }
  | {
      readonly type: "activate-disruption";
      readonly disruptionId: string;
      readonly affectedTrainRunIds: readonly string[];
      readonly delaySeconds: number;
    }
  | {
      readonly type: "clear-disruption";
      readonly disruptionId: string;
    }
  | {
      readonly type: "enter-external-zone";
      readonly trainRunId: string;
      readonly externalLeg: {
        readonly journeyChainId: string;
        readonly externalLegId: string;
        readonly fromPortalId: string;
        readonly toPortalId: string | null;
        readonly scheduledStartS: number;
        readonly scheduledEndS: number;
        readonly reentryEarliestS: number | null;
        readonly reentryLatestS: number | null;
        readonly fixedCostCents: string;
        readonly boundVehicleIds: readonly string[];
        readonly boundPersonnelDutyIds: readonly string[];
        readonly reentryRoute: readonly RegionalWaypointInput[];
        readonly firstResources: readonly string[];
      };
    }
  | {
      readonly type: "reenter-from-external";
      readonly trainRunId: string;
    };

export interface RegionalSimulationCommand {
  readonly schemaVersion: typeof REGIONAL_SIMULATION_COMMAND_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly commandId: string;
  readonly expectedStateHash: string;
  readonly expectedRevision: number;
  readonly expectedPublisherSequence: number;
  readonly command: RegionalSimulationCommandPayload;
}

export interface RegionalSimulationBatchCommand {
  readonly commandId: string;
  readonly command: RegionalSimulationCommandPayload;
}

export interface RegionalSimulationCommandBatch {
  readonly schemaVersion: typeof REGIONAL_SIMULATION_COMMAND_BATCH_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly expectedStateHash: string;
  readonly expectedRevision: number;
  readonly expectedPublisherSequence: number;
  readonly commands: readonly RegionalSimulationBatchCommand[];
}

export type RegionalSimulationState = Readonly<Record<string, unknown>> & {
  readonly schemaVersion: typeof REGIONAL_SIMULATION_STATE_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly initialNowS: number;
  readonly nowS: number;
  readonly revision: number;
  readonly publisherSequence: number;
  readonly commands: readonly unknown[];
};

export interface RegionalPublicTrain {
  readonly id: string;
  readonly baseTrainRunId?: string;
  readonly operator: string;
  readonly trainNumber: string;
  readonly category: RegionalTrainCategory;
  readonly positionMm: number;
  readonly speedMmPerSecond: number;
  readonly delaySeconds: number;
  readonly nextOperatingPoint: string;
  readonly status:
    | "planned"
    | "running"
    | "waiting"
    | "at_platform"
    | "completed"
    | "cancelled";
}

export interface RegionalLivemapSnapshot {
  readonly schemaVersion: typeof REGIONAL_LIVEMAP_SNAPSHOT_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly producerSequence: number;
  readonly atS: number;
  readonly trains: readonly RegionalPublicTrain[];
  readonly externalTrains?: readonly RegionalPublicExternalTrain[];
  readonly disruptions: readonly RegionalPublicDisruption[];
}

export interface RegionalPublicExternalTrain {
  readonly id: string;
  readonly operator: string;
  readonly trainNumber: string;
  readonly category: RegionalTrainCategory;
  readonly journeyChainId: string;
  readonly externalLegId: string;
  readonly fromPortalId: string;
  readonly toPortalId: string | null;
  readonly scheduledEndS: number;
  readonly reentryEarliestS: number | null;
  readonly reentryLatestS: number | null;
  readonly delaySeconds: number;
  readonly fixedCostCents: string;
  readonly boundVehicleIds: readonly string[];
  readonly boundPersonnelDutyIds: readonly string[];
  readonly status: "outside" | "ready-at-boundary" | "waiting-for-capacity" | "completed-outside";
  readonly progressBasisPoints: number;
}

export interface RegionalPublicDisruption {
  readonly schemaVersion: "zugfolge-livemap-disruption/v1";
  readonly disruptionId: string;
  readonly kind: "planned" | "unplanned";
  readonly publishedAtS: number;
  readonly startsAtS: number;
  readonly validUntilS: number;
  readonly positionMm: number;
  readonly causeCode: number;
  readonly causeLabel: string;
  readonly fineCauseId: string;
  readonly fineCauseLabel: string;
  readonly effect:
    | "closure"
    | "single-track"
    | "speed-restriction"
    | "platform-change"
    | "traffic-hold"
    | "route-deviation"
    | "vehicle-restriction"
    | "platform-usable-length";
  readonly affectedResource: string;
}

export interface RegionalLivemapDelta {
  readonly schemaVersion: typeof REGIONAL_LIVEMAP_DELTA_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly producerSequence: number;
  readonly atS: number;
  readonly changed: readonly RegionalPublicTrain[];
  readonly removed: readonly string[];
  readonly changedExternalTrains?: readonly RegionalPublicExternalTrain[];
  readonly removedExternalTrainIds?: readonly string[];
  readonly changedDisruptions: readonly RegionalPublicDisruption[];
  readonly removedDisruptionIds: readonly string[];
}

export interface RegionalSimulationEvent {
  readonly eventId: string;
  readonly worldId: string;
  readonly regionId: string;
  readonly simulationSequence: number;
  readonly eventType: string;
  readonly atS: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RegionalSimulationInitialized {
  readonly schemaVersion: typeof REGIONAL_SIMULATION_INITIALIZED_SCHEMA;
  readonly state: RegionalSimulationState;
  readonly stateHash: string;
  readonly snapshot: RegionalLivemapSnapshot;
  readonly events: readonly RegionalSimulationEvent[];
}

export interface RegionalSimulationRestored {
  readonly schemaVersion: typeof REGIONAL_SIMULATION_RESTORED_SCHEMA;
  readonly state: RegionalSimulationState;
  readonly stateHash: string;
  readonly snapshot: RegionalLivemapSnapshot;
}

export interface RegionalSimulationResult {
  readonly schemaVersion: typeof REGIONAL_SIMULATION_RESULT_SCHEMA;
  readonly state: RegionalSimulationState;
  readonly stateHash: string;
  readonly events: readonly RegionalSimulationEvent[];
  readonly delta: RegionalLivemapDelta;
  readonly appliedCommandId: string;
  readonly idempotentReplay: boolean;
}

export interface RegionalSimulationBatchCommandResult {
  readonly commandId: string;
  readonly idempotentReplay: boolean;
}

export interface RegionalSimulationBatchResult {
  readonly schemaVersion: typeof REGIONAL_SIMULATION_BATCH_RESULT_SCHEMA;
  readonly state: RegionalSimulationState;
  readonly stateHash: string;
  readonly events: readonly RegionalSimulationEvent[];
  readonly snapshot: RegionalLivemapSnapshot;
  readonly commandResults: readonly RegionalSimulationBatchCommandResult[];
}

export interface RegionalSimulationRuntime {
  readonly initialize: (
    input: RegionalSimulationInitialization,
  ) => RegionalSimulationInitialized;
  readonly restore: (state: RegionalSimulationState) => RegionalSimulationRestored;
  readonly apply: (
    state: RegionalSimulationState,
    command: RegionalSimulationCommand,
  ) => RegionalSimulationResult;
  readonly applyBatch: (
    state: RegionalSimulationState,
    batch: RegionalSimulationCommandBatch,
  ) => RegionalSimulationBatchResult;
}

export interface RegionalSimulationNativeAddon {
  readonly initializeRegionalSimulation: (inputJson: string) => string;
  readonly restoreRegionalSimulation: (stateJson: string) => string;
  readonly applyRegionalSimulationCommand: (
    stateJson: string,
    commandJson: string,
  ) => string;
  readonly applyRegionalSimulationCommandBatch: (
    stateJson: string,
    batchJson: string,
  ) => string;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${name} ist kein Objekt.`,
  );
}

function nonempty(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string" && value.length > 0, `${name} fehlt.`);
}

function sha256(value: unknown, name: string): asserts value is string {
  invariant(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    `${name} ist kein SHA-256.`,
  );
}

function safeInteger(value: unknown, name: string, nonnegative = true): asserts value is number {
  invariant(
    Number.isSafeInteger(value) && (!nonnegative || (value as number) >= 0),
    `${name} ist keine sichere${nonnegative ? " nichtnegative" : ""} Ganzzahl.`,
  );
}

function decodeState(value: unknown, name: string): RegionalSimulationState {
  record(value, name);
  invariant(
    value["schemaVersion"] === REGIONAL_SIMULATION_STATE_SCHEMA,
    `${name} hat ein unbekanntes Schema.`,
  );
  nonempty(value["worldId"], `${name}-Welt`);
  nonempty(value["regionId"], `${name}-Region`);
  safeInteger(value["initialNowS"], `${name}-Initialzeit`);
  safeInteger(value["nowS"], `${name}-Zeit`);
  safeInteger(value["revision"], `${name}-Revision`);
  safeInteger(value["publisherSequence"], `${name}-Publisher-Sequenz`);
  invariant(
    value["revision"] === value["publisherSequence"],
    `${name} besitzt auseinanderlaufende Sequenzen.`,
  );
  invariant(Array.isArray(value["commands"]), `${name} besitzt kein Kommandolog.`);
  invariant(
    value["commands"].length === value["revision"],
    `${name} besitzt eine unpassende Kommandologlaenge.`,
  );
  return value as RegionalSimulationState;
}

function decodePublicTrain(value: unknown, name: string): RegionalPublicTrain {
  record(value, name);
  nonempty(value["id"], `${name}-ID`);
  if (value["baseTrainRunId"] !== undefined) {
    nonempty(value["baseTrainRunId"], `${name}-Basisfahrt`);
    const baseTrainRunId = value["baseTrainRunId"];
    const prefix = `${baseTrainRunId}:day-`;
    invariant(
      !baseTrainRunId.includes(":day-")
      && value["id"].startsWith(prefix)
      && /^[1-9][0-9]*$/u.test(value["id"].slice(prefix.length)),
      `${name} besitzt keine kanonische Basisfahrtbindung.`,
    );
  }
  nonempty(value["operator"], `${name}-Betreiber`);
  nonempty(value["trainNumber"], `${name}-Zugnummer`);
  invariant(
    ["regional", "long-distance", "freight", "empty-stock", "engineering"].includes(
      value["category"] as string,
    ),
    `${name} hat eine unbekannte Zuggattung.`,
  );
  safeInteger(value["positionMm"], `${name}-Position`);
  safeInteger(value["speedMmPerSecond"], `${name}-Geschwindigkeit`);
  safeInteger(value["delaySeconds"], `${name}-Verspaetung`, false);
  nonempty(value["nextOperatingPoint"], `${name}-Folgebetriebsstelle`);
  invariant(
    ["planned", "running", "waiting", "at_platform", "completed", "cancelled"].includes(
      value["status"] as string,
    ),
    `${name} hat einen unbekannten Status.`,
  );
  return value as unknown as RegionalPublicTrain;
}

function decodePublicExternalTrain(value: unknown, name: string): RegionalPublicExternalTrain {
  record(value, name);
  for (const field of ["id", "operator", "trainNumber", "journeyChainId", "externalLegId", "fromPortalId"] as const) {
    nonempty(value[field], `${name}-${field}`);
  }
  invariant(
    ["regional", "long-distance", "freight", "empty-stock", "engineering"].includes(value["category"] as string),
    `${name} hat eine unbekannte Zuggattung.`,
  );
  invariant(value["toPortalId"] === null || (typeof value["toPortalId"] === "string" && value["toPortalId"].length > 0), `${name} besitzt kein gueltiges Zielportal.`);
  for (const field of ["scheduledEndS", "progressBasisPoints"] as const) safeInteger(value[field], `${name}-${field}`);
  safeInteger(value["delaySeconds"], `${name}-delaySeconds`, false);
  for (const field of ["reentryEarliestS", "reentryLatestS"] as const) {
    invariant(value[field] === null || (Number.isSafeInteger(value[field]) && (value[field] as number) >= 0), `${name}-${field} ist ungueltig.`);
  }
  invariant(typeof value["fixedCostCents"] === "string" && /^(0|[1-9][0-9]*)$/.test(value["fixedCostCents"]), `${name} besitzt keine Integer-Cent-Kosten.`);
  for (const field of ["boundVehicleIds", "boundPersonnelDutyIds"] as const) {
    invariant(Array.isArray(value[field]) && value[field].every((id) => typeof id === "string" && id.length > 0), `${name}-${field} ist ungueltig.`);
  }
  invariant(
    ["outside", "ready-at-boundary", "waiting-for-capacity", "completed-outside"].includes(value["status"] as string),
    `${name} hat einen unbekannten Aussenstatus.`,
  );
  invariant((value["progressBasisPoints"] as number) <= 10_000, `${name} hat ungueltigen Fortschritt.`);
  return value as unknown as RegionalPublicExternalTrain;
}

function decodeSnapshot(
  value: unknown,
  state: RegionalSimulationState,
  name: string,
): RegionalLivemapSnapshot {
  record(value, name);
  invariant(
    value["schemaVersion"] === REGIONAL_LIVEMAP_SNAPSHOT_SCHEMA,
    `${name} hat ein unbekanntes Schema.`,
  );
  invariant(
    value["worldId"] === state.worldId && value["regionId"] === state.regionId,
    `${name} verletzt die Welt- oder Regionsisolation.`,
  );
  safeInteger(value["producerSequence"], `${name}-Publisher-Sequenz`);
  safeInteger(value["atS"], `${name}-Zeit`);
  invariant(
    value["producerSequence"] === state.publisherSequence && value["atS"] === state.nowS,
    `${name} gehoert nicht zum Zustand.`,
  );
  invariant(Array.isArray(value["trains"]), `${name} besitzt keine Zuege.`);
  value["trains"].forEach((train, index) =>
    decodePublicTrain(train, `${name}-Zug ${index + 1}`),
  );
  if (value["externalTrains"] !== undefined) {
    invariant(Array.isArray(value["externalTrains"]), `${name} besitzt keine Aussenlaeufe.`);
    value["externalTrains"].forEach((train, index) => decodePublicExternalTrain(train, `${name}-Aussenlauf ${index + 1}`));
  }
  invariant(Array.isArray(value["disruptions"]), `${name} besitzt keine Störungsprojektion.`);
  value["disruptions"].forEach((item, index) => decodePublicDisruption(item, `${name}-Störung ${index + 1}`));
  return value as unknown as RegionalLivemapSnapshot;
}

function decodePublicDisruption(value: unknown, name: string): RegionalPublicDisruption {
  record(value, name);
  invariant(value["schemaVersion"] === "zugfolge-livemap-disruption/v1", `${name} hat ein unbekanntes Schema.`);
  nonempty(value["disruptionId"], `${name}-ID`);
  invariant(value["kind"] === "planned" || value["kind"] === "unplanned", `${name} hat keine Planungsart.`);
  for (const field of ["publishedAtS", "startsAtS", "validUntilS", "positionMm", "causeCode"] as const) {
    safeInteger(value[field], `${name}-${field}`);
  }
  for (const field of ["causeLabel", "fineCauseId", "fineCauseLabel", "effect", "affectedResource"] as const) {
    nonempty(value[field], `${name}-${field}`);
  }
  invariant(
    [
      "closure",
      "single-track",
      "speed-restriction",
      "platform-change",
      "traffic-hold",
      "route-deviation",
      "vehicle-restriction",
      "platform-usable-length",
    ].includes(value["effect"] as string),
    `${name} besitzt keine betriebswirksame Wirkung.`,
  );
  return value as unknown as RegionalPublicDisruption;
}

function decodeStateSnapshot<T extends RegionalSimulationInitialized | RegionalSimulationRestored>(
  json: string,
  expectedSchema:
    | typeof REGIONAL_SIMULATION_INITIALIZED_SCHEMA
    | typeof REGIONAL_SIMULATION_RESTORED_SCHEMA,
  name: string,
): T {
  const value: unknown = JSON.parse(json);
  record(value, name);
  invariant(value["schemaVersion"] === expectedSchema, `${name} hat ein unbekanntes Schema.`);
  const state = decodeState(value["state"], `${name}-Zustand`);
  sha256(value["stateHash"], `${name}-Zustandshash`);
  decodeSnapshot(value["snapshot"], state, `${name}-Snapshot`);
  if (expectedSchema === REGIONAL_SIMULATION_INITIALIZED_SCHEMA) {
    decodeEvents(value["events"], state, `${name}-Ereignisse`);
  }
  return value as unknown as T;
}

function decodeEvents(
  value: unknown,
  state: RegionalSimulationState,
  name: string,
): readonly RegionalSimulationEvent[] {
  invariant(Array.isArray(value), `${name} fehlen.`);
  for (const [index, event] of value.entries()) {
    record(event, `${name} ${index + 1}`);
    invariant(
      event["worldId"] === state.worldId && event["regionId"] === state.regionId,
      `${name} verletzen die Welt- oder Regionsisolation.`,
    );
    nonempty(event["eventId"], `${name}-ID`);
    nonempty(event["eventType"], `${name}-Typ`);
    safeInteger(event["simulationSequence"], `${name}-Simulationssequenz`);
    safeInteger(event["atS"], `${name}-Zeit`);
    record(event["payload"], `${name}-Payload`);
  }
  return value as readonly RegionalSimulationEvent[];
}

function decodeDelta(
  value: unknown,
  worldId: string,
  regionId: string,
): RegionalLivemapDelta {
  record(value, "Rust-M4-Delta");
  invariant(
    value["schemaVersion"] === REGIONAL_LIVEMAP_DELTA_SCHEMA,
    "Rust-M4-Delta hat ein unbekanntes Schema.",
  );
  invariant(Array.isArray(value["changedDisruptions"]), "Rust-M4-Delta besitzt keine Störungsänderungen.");
  if (value["changedExternalTrains"] !== undefined) {
    invariant(Array.isArray(value["changedExternalTrains"]), "Rust-M4-Delta besitzt keine Aussenlauf-Aenderungen.");
    value["changedExternalTrains"].forEach((train, index) => decodePublicExternalTrain(train, `Rust-M4-Delta-Aussenlauf ${index + 1}`));
  }
  if (value["removedExternalTrainIds"] !== undefined) {
    invariant(Array.isArray(value["removedExternalTrainIds"]) && value["removedExternalTrainIds"].every((id) => typeof id === "string" && id.length > 0), "Rust-M4-Delta besitzt ungueltige entfernte Aussenlaeufe.");
  }
  value["changedDisruptions"].forEach((item, index) => decodePublicDisruption(item, `Rust-M4-Delta-Störung ${index + 1}`));
  invariant(
    Array.isArray(value["removedDisruptionIds"]) && value["removedDisruptionIds"].every((id) => typeof id === "string" && id.length > 0),
    "Rust-M4-Delta besitzt ungültige Störungsentfernungen.",
  );
  invariant(
    value["worldId"] === worldId && value["regionId"] === regionId,
    "Rust-M4-Delta verletzt die Welt- oder Regionsisolation.",
  );
  safeInteger(value["producerSequence"], "Rust-M4-Delta-Sequenz");
  safeInteger(value["atS"], "Rust-M4-Delta-Zeit");
  invariant(Array.isArray(value["changed"]), "Rust-M4-Delta besitzt keine Aenderungen.");
  value["changed"].forEach((train, index) =>
    decodePublicTrain(train, `Rust-M4-Delta-Zug ${index + 1}`),
  );
  invariant(
    Array.isArray(value["removed"]) &&
      value["removed"].every((id) => typeof id === "string" && id.length > 0),
    "Rust-M4-Delta besitzt ungueltige Entfernungen.",
  );
  return value as unknown as RegionalLivemapDelta;
}

function decodeResult(json: string): RegionalSimulationResult {
  const value: unknown = JSON.parse(json);
  record(value, "Rust-M4-Kommandoergebnis");
  invariant(
    value["schemaVersion"] === REGIONAL_SIMULATION_RESULT_SCHEMA,
    "Rust-M4-Kommandoergebnis hat ein unbekanntes Schema.",
  );
  const state = decodeState(value["state"], "Rust-M4-Zustand");
  sha256(value["stateHash"], "Rust-M4-Zustandshash");
  const delta = decodeDelta(value["delta"], state.worldId, state.regionId);
  decodeEvents(value["events"], state, "Rust-M4-Ereignisse");
  nonempty(value["appliedCommandId"], "Rust-M4-Kommando-ID");
  invariant(
    typeof value["idempotentReplay"] === "boolean",
    "Rust-M4-Kommandoergebnis besitzt keine Replay-Aussage.",
  );
  return { ...(value as unknown as RegionalSimulationResult), state, delta };
}

function decodeBatchResult(json: string): RegionalSimulationBatchResult {
  const value: unknown = JSON.parse(json);
  record(value, "Rust-M4-Kommandogruppenergebnis");
  invariant(
    value["schemaVersion"] === REGIONAL_SIMULATION_BATCH_RESULT_SCHEMA,
    "Rust-M4-Kommandogruppenergebnis hat ein unbekanntes Schema.",
  );
  const state = decodeState(value["state"], "Rust-M4-Gruppenzustand");
  sha256(value["stateHash"], "Rust-M4-Gruppenzustandshash");
  const snapshot = decodeSnapshot(
    value["snapshot"],
    state,
    "Rust-M4-Gruppensnapshot",
  );
  decodeEvents(value["events"], state, "Rust-M4-Gruppenereignisse");
  invariant(
    Array.isArray(value["commandResults"]),
    "Rust-M4-Kommandogruppenergebnis besitzt keine Kommandoquittungen.",
  );
  for (const [index, result] of value["commandResults"].entries()) {
    record(result, `Rust-M4-Gruppenquittung ${index + 1}`);
    nonempty(result["commandId"], `Rust-M4-Gruppenquittung ${index + 1}-ID`);
    invariant(
      typeof result["idempotentReplay"] === "boolean",
      `Rust-M4-Gruppenquittung ${index + 1} besitzt keine Replay-Aussage.`,
    );
  }
  return {
    ...(value as unknown as RegionalSimulationBatchResult),
    state,
    snapshot,
  };
}

/** Umschliesst die native ABI; exportiert fuer fokussierte Vertragstests. */
export function regionalSimulationRuntimeFromAddon(
  addon: RegionalSimulationNativeAddon,
): RegionalSimulationRuntime {
  return Object.freeze({
    initialize(input: RegionalSimulationInitialization) {
      const initialized = decodeStateSnapshot<RegionalSimulationInitialized>(
        addon.initializeRegionalSimulation(JSON.stringify(input)),
        REGIONAL_SIMULATION_INITIALIZED_SCHEMA,
        "Rust-M4-Initialisierung",
      );
      invariant(
        initialized.state.worldId === input.worldId &&
          initialized.state.regionId === input.regionId,
        "Rust-M4-Initialisierung verletzte die Welt- oder Regionsisolation.",
      );
      invariant(
        initialized.state.revision === 0,
        "Rust-M4-Initialisierung begann nicht bei Revision 0.",
      );
      return initialized;
    },
    restore(state: RegionalSimulationState) {
      const restored = decodeStateSnapshot<RegionalSimulationRestored>(
        addon.restoreRegionalSimulation(JSON.stringify(state)),
        REGIONAL_SIMULATION_RESTORED_SCHEMA,
        "Rust-M4-Wiederherstellung",
      );
      invariant(
        restored.state.worldId === state.worldId &&
          restored.state.regionId === state.regionId,
        "Rust-M4-Wiederherstellung verletzte die Welt- oder Regionsisolation.",
      );
      invariant(
        restored.state.revision === state.revision,
        "Rust-M4-Wiederherstellung veraenderte die Revision.",
      );
      return restored;
    },
    apply(state: RegionalSimulationState, command: RegionalSimulationCommand) {
      invariant(
        state.worldId === command.worldId && state.regionId === command.regionId,
        "M4-Kommando verletzt die Welt- oder Regionsisolation.",
      );
      sha256(command.expectedStateHash, "M4-Kommando-Zustandshash");
      safeInteger(command.expectedRevision, "M4-Kommando-Revision");
      safeInteger(command.expectedPublisherSequence, "M4-Kommando-Publisher-Sequenz");
      const result = decodeResult(
        addon.applyRegionalSimulationCommand(JSON.stringify(state), JSON.stringify(command)),
      );
      invariant(
        result.state.worldId === command.worldId &&
          result.state.regionId === command.regionId,
        "Rust-M4-Kommando verletzte die Welt- oder Regionsisolation.",
      );
      invariant(
        result.appliedCommandId === command.commandId,
        "Rust-M4-Kommando quittierte eine fremde Kommando-ID.",
      );
      if (!result.idempotentReplay) {
        invariant(
          result.state.revision === command.expectedRevision + 1 &&
            result.state.publisherSequence === command.expectedPublisherSequence + 1 &&
            result.delta.producerSequence === result.state.publisherSequence,
          "Rust-M4-Kommando erzeugte eine Sequenzluecke.",
        );
      }
      return result;
    },
    applyBatch(state: RegionalSimulationState, batch: RegionalSimulationCommandBatch) {
      invariant(
        state.worldId === batch.worldId && state.regionId === batch.regionId,
        "M4-Kommandogruppe verletzt die Welt- oder Regionsisolation.",
      );
      invariant(batch.commands.length > 0, "M4-Kommandogruppe darf nicht leer sein.");
      invariant(
        batch.commands.length <= REGIONAL_SIMULATION_MAX_BATCH_COMMANDS,
        `M4-Kommandogruppe darf hoechstens ${REGIONAL_SIMULATION_MAX_BATCH_COMMANDS} Kommandos enthalten.`,
      );
      sha256(batch.expectedStateHash, "M4-Kommandogruppe-Zustandshash");
      safeInteger(batch.expectedRevision, "M4-Kommandogruppe-Revision");
      safeInteger(
        batch.expectedPublisherSequence,
        "M4-Kommandogruppe-Publisher-Sequenz",
      );
      const commandIds = new Set<string>();
      for (const command of batch.commands) {
        nonempty(command.commandId, "M4-Kommandogruppe-Kommando-ID");
        invariant(
          !commandIds.has(command.commandId),
          "M4-Kommandogruppe besitzt doppelte Kommando-IDs.",
        );
        commandIds.add(command.commandId);
      }
      const result = decodeBatchResult(
        addon.applyRegionalSimulationCommandBatch(
          JSON.stringify(state),
          JSON.stringify(batch),
        ),
      );
      invariant(
        result.state.worldId === batch.worldId && result.state.regionId === batch.regionId,
        "Rust-M4-Kommandogruppe verletzte die Welt- oder Regionsisolation.",
      );
      invariant(
        result.commandResults.length === batch.commands.length,
        "Rust-M4-Kommandogruppe quittierte nicht alle Kommandos.",
      );
      let sawAppliedCommand = false;
      for (const [index, commandResult] of result.commandResults.entries()) {
        invariant(
          commandResult.commandId === batch.commands[index]?.commandId,
          "Rust-M4-Kommandogruppe quittierte eine fremde Kommando-ID.",
        );
        if (commandResult.idempotentReplay) {
          invariant(
            !sawAppliedCommand,
            "Rust-M4-Kommandogruppe besitzt einen Replay nach einem neuen Kommando.",
          );
        } else {
          sawAppliedCommand = true;
        }
      }
      const appliedCount = result.commandResults.filter(
        (commandResult) => !commandResult.idempotentReplay,
      ).length;
      invariant(
        result.state.revision === batch.expectedRevision + appliedCount
          && result.state.publisherSequence
            === batch.expectedPublisherSequence + appliedCount
          && result.snapshot.producerSequence === result.state.publisherSequence,
        "Rust-M4-Kommandogruppe erzeugte eine Sequenzluecke.",
      );
      if (appliedCount === 0) {
        invariant(
          result.stateHash === batch.expectedStateHash && result.events.length === 0,
          "Idempotenter Rust-M4-Gruppenreplay veraenderte den Zustand.",
        );
      }
      return result;
    },
  });
}

/**
 * Laedt ausschliesslich das konfigurierte In-Process-Addon. Es gibt bewusst
 * keinen TypeScript-Fallback fuer den autoritativen Produktionspfad.
 */
export function loadRegionalSimulationRuntime(
  addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"],
): RegionalSimulationRuntime {
  invariant(addonPath !== undefined && addonPath.length > 0, "ZUGFOLGE_RUNTIME_NATIVE_PATH fehlt.");
  invariant(isAbsolute(addonPath), "ZUGFOLGE_RUNTIME_NATIVE_PATH muss absolut sein.");
  const required: unknown = createRequire(import.meta.url)(addonPath);
  record(required, "napi-rs-Addon");
  invariant(
    typeof required["initializeRegionalSimulation"] === "function",
    "napi-rs-Addon exportiert initializeRegionalSimulation nicht.",
  );
  invariant(
    typeof required["restoreRegionalSimulation"] === "function",
    "napi-rs-Addon exportiert restoreRegionalSimulation nicht.",
  );
  invariant(
    typeof required["applyRegionalSimulationCommand"] === "function",
    "napi-rs-Addon exportiert applyRegionalSimulationCommand nicht.",
  );
  invariant(
    typeof required["applyRegionalSimulationCommandBatch"] === "function",
    "napi-rs-Addon exportiert applyRegionalSimulationCommandBatch nicht.",
  );
  return regionalSimulationRuntimeFromAddon(required as unknown as RegionalSimulationNativeAddon);
}
