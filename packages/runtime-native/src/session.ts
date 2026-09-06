import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { parsePassengerProjectionV2 } from "./interior.js";
import { CONDUCTOR_SESSION_ERROR_CODES } from "./session-errors.js";
import type { ApplyConductorSessionCommandInputV1, ConductorSessionAccessV1, ConductorSessionPolicyV1,
  ConductorSessionSnapshotV1, ConductorSessionSourceV1, ConductorSessionTransitionV1, ConductorTrainStateV1,
  SynchronizeConductorSessionInputV1 } from "./session-types.js";

export interface ConductorSessionNativeAddon {
  initializeConductorSessionState(input: string): string;
  applyConductorSessionCommand(input: string): string;
  synchronizeConductorSession(input: string): string;
  restoreConductorSessionState(input: string): string;
  projectConductorSessionSnapshot(input: string): string;
  replayConductorSession(input: string): string;
  hashConductorOperationalWorld(input: string): string;
  hashConductorSessionPolicy(input: string): string;
}
export interface ConductorSessionRuntime {
  initialize(worldId: string, trainRunId: string, nowMs: number): ConductorTrainStateV1;
  apply(input: ApplyConductorSessionCommandInputV1): ConductorSessionTransitionV1;
  synchronize(input: SynchronizeConductorSessionInputV1): ConductorSessionTransitionV1;
  restore(state: ConductorTrainStateV1, expectedStateHash: string, dialogueReleases: readonly Readonly<Record<string, unknown>>[]): ConductorTrainStateV1;
  project(state: ConductorTrainStateV1, access: ConductorSessionAccessV1, source: ConductorSessionSourceV1): ConductorSessionSnapshotV1 | null;
  replay(input: Readonly<Record<string, unknown>>): ConductorTrainStateV1;
  operationalWorldHash(world: Readonly<Record<string, unknown>>): string;
  policyHash(policy: ConductorSessionPolicyV1): string;
}
export class ConductorSessionError extends Error {
  constructor(readonly code: string) { super("Der Sitzungsbefehl wurde vom autoritativen Kern abgelehnt."); }
}
const fail = (): never => { throw new ConductorSessionError("session_transport_invalid"); };
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  if (keys !== undefined && (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))) fail();
  return row;
}
function text(value: unknown, maximum = 500): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail();
}
function natural(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 0) fail(); }
function digest(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(); }
function oneOf(value: unknown, values: readonly string[]) { if (typeof value !== "string" || !values.includes(value)) fail(); }
function point(value: unknown) {
  const row = record(value, ["vehicleId", "bodyId", "deckId", "xMm", "yMm"]);
  text(row["vehicleId"]); text(row["bodyId"]); oneOf(row["deckId"], ["main", "lower", "upper"]); natural(row["xMm"]); natural(row["yMm"]);
}
const status = ["active", "detached", "ended"];
const endReasons = ["requested", "lease_expired", "access_revoked", "train_completed", "train_unavailable", "formation_changed", "historical_external_leg"];

/** Strikte öffentliche Whitelist; insbesondere keine Account-, FareFact- oder Zukunftsknoten. */
export function parseConductorSessionSnapshot(value: unknown): ConductorSessionSnapshotV1 {
  const row = record(value, ["schemaVersion", "worldId", "trainRunId", "sessionId", "operatorId", "status", "revision", "sequence",
    "nowMs", "leaseUntilMs", "endReason", "position", "pins", "passengers", "activeEncounter", "snapshotHash"]);
  if (row["schemaVersion"] !== "conductor-session-snapshot/v1") fail();
  for (const key of ["worldId", "trainRunId", "sessionId", "operatorId"]) text(row[key]);
  for (const key of ["revision", "sequence", "nowMs", "leaseUntilMs"]) natural(row[key]);
  oneOf(row["status"], status); if (row["endReason"] !== null) oneOf(row["endReason"], endReasons);
  point(row["position"]); digest(row["snapshotHash"]);
  const pins = record(row["pins"], ["periodId", "operationalWorldHash", "operationalFormationId", "formationId", "vehicleIds",
    "interiorLayoutHash", "demandStateHash", "manifestRevision", "projectionHash", "dialogueReleaseHash", "policyHash"]);
  for (const key of ["periodId", "operationalFormationId", "formationId"]) text(pins[key]);
  for (const key of ["operationalWorldHash", "interiorLayoutHash", "demandStateHash", "projectionHash", "dialogueReleaseHash", "policyHash"]) digest(pins[key]);
  natural(pins["manifestRevision"]);
  const vehicleIds = pins["vehicleIds"];
  if (!Array.isArray(vehicleIds) || vehicleIds.length === 0 || vehicleIds.length > 32) return fail();
  for (const id of vehicleIds) text(id);
  if (new Set(vehicleIds).size !== vehicleIds.length) fail();
  const passengers = parsePassengerProjectionV2(row["passengers"]);
  if (passengers.binding.worldId !== row["worldId"] || passengers.binding.trainRunId !== row["trainRunId"]
    || passengers.binding.operatorId !== row["operatorId"] || passengers.binding.manifestRevision !== pins["manifestRevision"]
    || passengers.stateHash !== pins["projectionHash"] || passengers.sourceLayoutHash !== pins["interiorLayoutHash"]) fail();
  if (row["activeEncounter"] !== null) {
    const encounter = record(row["activeEncounter"], ["schemaVersion", "encounterId", "revision", "status", "passengerText", "options", "hints", "availableAtMs"]);
    if (encounter["schemaVersion"] !== "passenger-encounter/v1") fail();
    text(encounter["encounterId"]); text(encounter["passengerText"], 600); natural(encounter["revision"]); natural(encounter["availableAtMs"]);
    oneOf(encounter["status"], ["active", "closed"]);
    const options = encounter["options"];
    if (!Array.isArray(options) || options.length > 12) return fail();
    const ids: string[] = [];
    for (const item of options) {
      const option = record(item, ["optionId", "text", "timeCostMs"]); text(option["optionId"]); text(option["text"], 300); natural(option["timeCostMs"]); ids.push(option["optionId"]);
    }
    if (new Set(ids).size !== ids.length) fail();
    const hints = record(encounter["hints"], ["documentStatus", "acquisitionException", "identityStatus", "concreteDanger"]);
    oneOf(hints["documentStatus"], ["unchecked", "verified_valid", "not_presentable", "verified_invalid"]);
    oneOf(hints["acquisitionException"], ["unknown", "proven", "excluded"]);
    oneOf(hints["identityStatus"], ["unknown", "confirmed", "refused"]);
    if (typeof hints["concreteDanger"] !== "boolean") fail();
  }
  return value as ConductorSessionSnapshotV1;
}
function privateState(value: unknown): ConductorTrainStateV1 {
  const row = record(value);
  if (row["schemaVersion"] !== "conductor-train-state/v1") fail();
  text(row["worldId"]); text(row["trainRunId"]); digest(row["stateHash"]);
  for (const key of ["revision", "sequence", "nowMs"]) natural(row[key]);
  for (const key of ["encounters", "commandReceipts", "controlReceipts"]) record(row[key]);
  if (row["session"] !== null) {
    const session = record(row["session"]); text(session["sessionId"]); text(session["ownerRef"]); text(session["operatorId"]);
    oneOf(session["status"], status); natural(session["leaseUntilMs"]); natural(session["revision"]);
  }
  return value as ConductorTrainStateV1;
}
function invoke(method: (json: string) => string, input: unknown): unknown {
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json) > 128 * 1024 * 1024) fail();
  let result: string;
  try { result = method(json); } catch (error) {
    throw new ConductorSessionError(error instanceof Error && CONDUCTOR_SESSION_ERROR_CODES.has(error.message) ? error.message : "session_command_rejected");
  }
  if (typeof result !== "string" || Buffer.byteLength(result) > 128 * 1024 * 1024) fail();
  try { return JSON.parse(result) as unknown; } catch { return fail(); }
}
function transition(value: unknown, worldId: string, trainRunId: string): ConductorSessionTransitionV1 {
  const row = record(value, ["schemaVersion", "state", "stateHash", "receipt", "snapshot", "events", "effects"]);
  const state = privateState(row["state"]);
  if (state.worldId !== worldId || state.trainRunId !== trainRunId || row["stateHash"] !== state.stateHash) fail();
  if (row["snapshot"] !== null) {
    const snapshot = parseConductorSessionSnapshot(row["snapshot"]);
    if (snapshot.worldId !== worldId || snapshot.trainRunId !== trainRunId || snapshot.revision !== state.session?.revision || snapshot.sequence !== state.sequence) fail();
  }
  const events = row["events"], effects = row["effects"];
  if (!Array.isArray(events) || !Array.isArray(effects)) return fail();
  if (row["receipt"] !== null) {
    const receipt = record(row["receipt"], ["schemaVersion", "worldId", "trainRunId", "sessionId", "idempotencyKey", "commandHash", "revision", "sequence", "eventKind"]);
    if (receipt["worldId"] !== worldId || receipt["trainRunId"] !== trainRunId) fail();
    digest(receipt["commandHash"]); natural(receipt["revision"]); natural(receipt["sequence"]);
  }
  for (const item of [...events, ...effects]) {
    const event = record(item); if (event["worldId"] !== worldId || event["trainRunId"] !== trainRunId) fail();
  }
  return value as ConductorSessionTransitionV1;
}
export function conductorSessionRuntimeFromAddon(addon: ConductorSessionNativeAddon): ConductorSessionRuntime {
  return {
    initialize(worldId, trainRunId, nowMs) {
      const state = privateState(invoke((json) => addon.initializeConductorSessionState(json), { schemaVersion: "conductor-session-initialize-input/v1", worldId, trainRunId, nowMs }));
      if (state.worldId !== worldId || state.trainRunId !== trainRunId || state.nowMs !== nowMs) fail(); return state;
    },
    apply(input) { return transition(invoke((json) => addon.applyConductorSessionCommand(json), input), input.state.worldId, input.state.trainRunId); },
    synchronize(input) { return transition(invoke((json) => addon.synchronizeConductorSession(json), input), input.state.worldId, input.state.trainRunId); },
    restore(state, expectedStateHash, dialogueReleases) {
      const result = privateState(invoke((json) => addon.restoreConductorSessionState(json), { schemaVersion: "conductor-session-restore-input/v1", state, expectedStateHash, dialogueReleases }));
      if (result.stateHash !== expectedStateHash || result.worldId !== state.worldId || result.trainRunId !== state.trainRunId) fail(); return result;
    },
    project(state, access, source) {
      const result = invoke((json) => addon.projectConductorSessionSnapshot(json), { schemaVersion: "conductor-session-project-input/v1", state, expectedStateHash: state.stateHash, access, source });
      if (result === null) return null;
      const snapshot = parseConductorSessionSnapshot(result);
      if (snapshot.worldId !== state.worldId || snapshot.trainRunId !== state.trainRunId || snapshot.operatorId !== access.operatorId) fail(); return snapshot;
    },
    replay(input) { return privateState(invoke((json) => addon.replayConductorSession(json), input)); },
    operationalWorldHash(world) { const value = addon.hashConductorOperationalWorld(JSON.stringify(world)); digest(value); return value; },
    policyHash(policy) { const value = addon.hashConductorSessionPolicy(JSON.stringify(policy)); digest(value); return value; },
  };
}
export function loadConductorSessionRuntime(addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"]): ConductorSessionRuntime {
  if (addonPath === undefined || !isAbsolute(addonPath)) throw new TypeError("Absoluter Runtime-Addonpfad fehlt.");
  const value = record(createRequire(import.meta.url)(addonPath));
  for (const method of ["initializeConductorSessionState", "applyConductorSessionCommand", "synchronizeConductorSession", "restoreConductorSessionState",
    "projectConductorSessionSnapshot", "replayConductorSession", "hashConductorOperationalWorld", "hashConductorSessionPolicy"]) {
    if (typeof value[method] !== "function") throw new TypeError("Runtime-Addon exportiert den vollständigen Sitzungsvertrag nicht.");
  }
  return conductorSessionRuntimeFromAddon(value as unknown as ConductorSessionNativeAddon);
}

export function loadConductorDialogueValidator(addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"]): { validateConductorDialogueRelease(input: string): string } {
  if (addonPath === undefined || !isAbsolute(addonPath)) throw new TypeError("Absoluter Runtime-Addonpfad fehlt.");
  const addon = record(createRequire(import.meta.url)(addonPath));
  if (typeof addon["validateConductorDialogueRelease"] !== "function") throw new TypeError("Runtime-Addon exportiert den Dialogvalidator nicht.");
  return { validateConductorDialogueRelease: (json) => (addon["validateConductorDialogueRelease"] as (input: string) => string)(json) };
}
