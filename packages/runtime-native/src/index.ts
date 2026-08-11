import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

export * from "./regional-simulation.js";

export const OPERATING_INITIALIZE_SCHEMA = "zugfolge-operating-world-initialize/v1" as const;
export const OPERATING_STATE_SCHEMA = "zugfolge-operating-world-state/v1" as const;
export const OPERATING_TRANSITION_SCHEMA = "zugfolge-operating-transition-command/v1" as const;
export const OPERATING_RESULT_SCHEMA = "zugfolge-operating-transition-result/v1" as const;
export const FLEET_MOBILIZATION_VERIFICATION_SCHEMA = "zugfolge-fleet-mobilization-verification/v1" as const;
export const FLEET_INITIALIZE_SCHEMA = "zugfolge-fleet-world-initialize/v1" as const;
export const FLEET_INITIALIZED_SCHEMA = "zugfolge-fleet-world-initialized/v1" as const;
export const FLEET_STATE_SCHEMA = "zugfolge-fleet-world-state/v1" as const;
export const FLEET_FORMATION_COMMAND_SCHEMA = "zugfolge-fleet-formation-command/v1" as const;
export const FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA = "zugfolge-fleet-personnel-duty-command/v1" as const;
export const FLEET_PATH_RESERVATION_COMMAND_SCHEMA = "zugfolge-fleet-path-reservation-command/v1" as const;
export const FLEET_COMMAND_RESULT_SCHEMA = "zugfolge-fleet-command-result/v1" as const;

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

export interface FleetWorldInitialization {
  readonly schemaVersion: typeof FLEET_INITIALIZE_SCHEMA;
  readonly worldId: string;
  readonly producedAt: number;
}

export interface NativeProcessedFleetCommand {
  readonly commandHash: string;
  readonly resultingRevision: number;
  readonly entityKind: "formation" | "personnel-duty" | "path-reservation";
  readonly entityId: string;
}

export type NativeFleetWorldState = Readonly<Record<string, unknown>> & {
  readonly schemaVersion: typeof FLEET_STATE_SCHEMA;
  readonly worldId: string;
  readonly revision: number;
  readonly producedAt: number;
  readonly formations: Readonly<Record<string, NativeFleetFormation>>;
  readonly personnelDuties: Readonly<Record<string, NativeFleetPersonnelDuty>>;
  readonly pathReservations: Readonly<Record<string, NativeFleetPathReservation>>;
  readonly processedCommands: Readonly<Record<string, NativeProcessedFleetCommand>>;
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
      readonly formation: NativeFleetFormation;
    }
  | FleetCommandBase & {
      readonly schemaVersion: typeof FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA;
      readonly personnelDuty: NativeFleetPersonnelDuty;
    }
  | FleetCommandBase & {
      readonly schemaVersion: typeof FLEET_PATH_RESERVATION_COMMAND_SCHEMA;
      readonly pathReservation: NativeFleetPathReservation;
    };

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
  readonly applyFleetCommand: (stateJson: string, commandJson: string) => string;
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
  record(value["state"]["formations"], `${name}-Zustandsformationen`);
  record(value["state"]["personnelDuties"], `${name}-Zustandspersonaldienste`);
  record(value["state"]["pathReservations"], `${name}-Zustandstrassen`);
  record(value["state"]["processedCommands"], `${name}-Kommandoquittungen`);
  for (const [commandId, rawProcessed] of Object.entries(value["state"]["processedCommands"])) {
    invariant(commandId.length > 0, `${name}-Kommandoquittung hat keine Kommando-ID.`);
    record(rawProcessed, `${name}-Kommandoquittung`);
    sha256(rawProcessed["commandHash"], `${name}-Kommandoquittungshash`);
    safeInteger(rawProcessed["resultingRevision"], `${name}-Kommandoquittungsrevision`);
    invariant(
      (rawProcessed["resultingRevision"] as number) <= (value["state"]["revision"] as number),
      `${name}-Kommandoquittung verweist auf eine zukuenftige Revision.`,
    );
    invariant(
      ["formation", "personnel-duty", "path-reservation"].includes(rawProcessed["entityKind"] as string),
      `${name}-Kommandoquittung hat eine unbekannte Entitaetsart.`,
    );
    invariant(typeof rawProcessed["entityId"] === "string" && rawProcessed["entityId"].length > 0, `${name}-Kommandoquittung hat keine Entitaets-ID.`);
  }
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

function fleetCommandEntity(command: NativeFleetCommand): { readonly kind: FleetCommandResult["entityKind"]; readonly id: string } {
  switch (command.schemaVersion) {
    case FLEET_FORMATION_COMMAND_SCHEMA:
      return { kind: "formation", id: command.formation.id };
    case FLEET_PERSONNEL_DUTY_COMMAND_SCHEMA:
      return { kind: "personnel-duty", id: command.personnelDuty.id };
    case FLEET_PATH_RESERVATION_COMMAND_SCHEMA:
      return { kind: "path-reservation", id: command.pathReservation.id };
  }
}

/** Wraps the native ABI. Exported for contract tests; production uses {@link loadOperatingRuntime}. */
export function operatingRuntimeFromAddon(addon: NativeAddon): NativeRuntime {
  return Object.freeze({
    initializeFleet(input: FleetWorldInitialization) {
      const initialized = decodeFleetInitialized(addon.initializeFleetWorld(JSON.stringify(input)));
      invariant(initialized.state.worldId === input.worldId, "Rust-M5-Initialisierung verletzte die Weltisolation.");
      invariant(initialized.state.revision === 0, "Rust-M5-Initialisierung begann nicht bei Revision 0.");
      invariant(initialized.state.producedAt === input.producedAt, "Rust-M5-Initialisierung veraenderte die Zustandszeit.");
      return initialized;
    },
    applyFleetCommand(state: NativeFleetWorldState, command: NativeFleetCommand) {
      invariant(state.worldId === command.worldId, "M5-Kommando verletzt die Weltisolation.");
      safeInteger(command.expectedRevision, "M5-Kommando-Revision");
      safeInteger(command.atS, "M5-Kommando-Zeit");
      sha256(command.expectedStateHash, "M5-Kommando-Zustandshash");
      const entity = fleetCommandEntity(command);
      invariant(entity.id.length > 0, "M5-Kommando besitzt keine Entitaets-ID.");
      const result = decodeFleetCommandResult(addon.applyFleetCommand(JSON.stringify(state), JSON.stringify(command)));
      invariant(result.state.worldId === command.worldId, "Rust-M5-Kommando verletzte die Weltisolation.");
      invariant(result.appliedCommandId === command.commandId, "Rust-M5-Kommando quittierte eine fremde Kommando-ID.");
      invariant(result.entityKind === entity.kind && result.entityId === entity.id, "Rust-M5-Kommando quittierte eine fremde Entitaet.");
      invariant(result.idempotentReplay || result.state.revision === command.expectedRevision + 1, "Rust-M5-Kommando erhoehte die Revision nicht exakt einmal.");
      invariant(result.idempotentReplay || result.state.producedAt === command.atS, "Rust-M5-Kommando veraenderte die Zustandszeit.");
      const processed = result.state.processedCommands[command.commandId];
      invariant(processed !== undefined, "Rust-M5-Zustand enthaelt keine Kommandoquittung.");
      invariant(processed.entityKind === entity.kind && processed.entityId === entity.id, "Rust-M5-Kommandoquittung gehoert zu einer fremden Entitaet.");
      invariant(result.idempotentReplay || processed.resultingRevision === result.state.revision, "Rust-M5-Kommandoquittung bindet nicht die neue Revision.");
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
