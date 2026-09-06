import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { DialogueEvidenceV1 } from "@zugfolge/runtime-native";
import type { ConductorCommittedContext } from "./conductor-context.js";

export type ControlRecord = Readonly<Record<string, unknown>>;
export interface ControlCase extends ControlRecord {
  readonly caseId: string; readonly pin: ControlRecord & { readonly worldId: string; readonly operatorId: string;
    readonly trainRunId: string; readonly encounterId: string; readonly inspectedAtMs: number; readonly economyRelease: ControlRecord };
  readonly status: "open" | "closed_without_claim" | "claim_open" | "settled";
  readonly evidence: DialogueEvidenceV1; readonly policeHoldId: string | null;
}
export interface ControlPolicePlan extends ControlRecord {
  readonly holdId: string; readonly trainRunId: string; readonly requestedAtMs: number;
  readonly model: ControlRecord; readonly resolution: string;
}
export interface ControlLedgerEvent extends ControlRecord {
  readonly eventId: string; readonly worldId: string; readonly operatorId: string; readonly atMs: number;
  readonly dayStartMs: number; readonly kind: string; readonly caseId: string | null; readonly economyReleaseHash: string;
  readonly postings: readonly { readonly role: string; readonly amountCents: string }[];
}
export interface FareControlState extends ControlRecord {
  readonly schemaVersion: "fare-control-world-state/v1"; readonly worldId: string; readonly operatorId: string;
  readonly revision: number; readonly nowMs: number; readonly stateHash: string;
  readonly cases: Readonly<Record<string, ControlCase>>; readonly policePlans: Readonly<Record<string, ControlPolicePlan>>;
  readonly days: Readonly<Record<string, ControlRecord>>; readonly receipts: Readonly<Record<string, ControlRecord>>;
  readonly ledgerEvents: Readonly<Record<string, ControlLedgerEvent>>;
}
export interface FareControlTransition {
  readonly state: FareControlState; readonly receipt: ControlRecord; readonly ledgerEvents: readonly ControlLedgerEvent[];
}
export interface FareControlRuntime {
  initialize(worldId: string, operatorId: string, nowMs: number): FareControlState;
  apply(state: FareControlState, command: ControlRecord): FareControlTransition;
  restore(state: FareControlState, expectedStateHash: string): FareControlState;
  project(state: FareControlState): readonly ControlRecord[];
  policyHash(policy: ControlRecord): string;
  journeyHash(evidence: ControlRecord): string;
  modelHash(model: ControlRecord): string;
  nextWakeup(state: FareControlState): number | null;
  policeDue(plan: ControlPolicePlan, evidence: ControlRecord, nowMs: number): "identity_confirmed" | "identity_not_confirmed" | "unavailable" | null;
}
export class FareControlRuntimeError extends Error {
  constructor() { super("fare_control_core_rejected"); this.name = "FareControlRuntimeError"; }
}
function fail(): never { throw new FareControlRuntimeError(); }
export function controlRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(); return value as Record<string, unknown>;
}
export function controlText(value: unknown): string { if (typeof value !== "string" || value.length === 0) fail(); return value; }
function integerNumbers(value: unknown): void {
  if (typeof value === "number" && !Number.isSafeInteger(value)) fail();
  if (Array.isArray(value)) for (const item of value) integerNumbers(item);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) integerNumbers(item);
}
export function controlJson(value: unknown): string {
  integerNumbers(value);
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
}
function state(value: unknown): FareControlState {
  const row = controlRecord(value); integerNumbers(row);
  if (row["schemaVersion"] !== "fare-control-world-state/v1" || typeof row["worldId"] !== "string"
    || typeof row["operatorId"] !== "string" || !Number.isSafeInteger(row["revision"]) || !Number.isSafeInteger(row["nowMs"])
    || typeof row["stateHash"] !== "string" || !/^[a-f0-9]{64}$/u.test(row["stateHash"])) fail();
  for (const field of ["cases", "policePlans", "days", "receipts", "ledgerEvents"]) controlRecord(row[field]);
  return row as unknown as FareControlState;
}
export function fareControlRuntimeFromAddon(addon: Readonly<Record<string, unknown>>): FareControlRuntime {
  function invoke(name: string, input: unknown): unknown {
    try {
      const method = addon[name]; if (typeof method !== "function") fail();
      const result: unknown = JSON.parse((method as (source: string) => string)(controlJson(input)));
      integerNumbers(result); return result;
    } catch { return fail(); }
  }
  function digest(name: string, input: unknown): string {
    const value = invoke(name, input); if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(); return value;
  }
  return Object.freeze({
    initialize(worldId: string, operatorId: string, nowMs: number) {
      const result = state(invoke("initializeFareControl", { worldId, operatorId, nowMs }));
      if (result.worldId !== worldId || result.operatorId !== operatorId || result.nowMs !== nowMs) fail(); return result;
    },
    apply(current: FareControlState, command: ControlRecord) {
      const row = controlRecord(invoke("applyFareControl", { state: current, expectedStateHash: current.stateHash, command }));
      const next = state(row["state"]);
      if (next.worldId !== current.worldId || next.operatorId !== current.operatorId || !Array.isArray(row["ledgerEvents"])) fail();
      return { state: next, receipt: controlRecord(row["receipt"]), ledgerEvents: row["ledgerEvents"] as readonly ControlLedgerEvent[] };
    },
    restore(current: FareControlState, expectedStateHash: string) {
      const result = state(invoke("restoreFareControl", { state: current, expectedStateHash }));
      if (result.stateHash !== expectedStateHash || result.worldId !== current.worldId || result.operatorId !== current.operatorId) fail(); return result;
    },
    project(current: FareControlState) {
      const result = invoke("projectFareCases", { state: current, expectedStateHash: current.stateHash, worldId: current.worldId, operatorId: current.operatorId });
      if (!Array.isArray(result)) fail();
      const fields = ["caseId", "encounterId", "trainRunId", "status", "evidence", "claimKind", "claimCents", "paidCents", "costsCents", "writtenOffCents", "proofDeadlineMs"];
      for (const item of result) { const row = controlRecord(item); if (Object.keys(row).length !== fields.length || fields.some((field) => !Object.hasOwn(row, field))) fail(); }
      return result as readonly ControlRecord[];
    },
    policyHash: (input: ControlRecord) => digest("hashFareInspectionPolicy", input),
    journeyHash: (input: ControlRecord) => digest("hashFareJourneyEvidence", input),
    modelHash: (input: ControlRecord) => digest("hashPoliceResponseModel", input),
    nextWakeup(current: FareControlState) {
      const value = invoke("nextFareControlWakeup", { state: current, expectedStateHash: current.stateHash });
      if (value !== null && (typeof value !== "number" || value < 0)) fail(); return value;
    },
    policeDue(plan: ControlPolicePlan, evidence: ControlRecord, nowMs: number) {
      const value = invoke("duePoliceResponse", { plan, evidence, nowMs });
      if (value !== null && value !== "identity_confirmed" && value !== "identity_not_confirmed" && value !== "unavailable") fail(); return value;
    },
  });
}
export function loadFareControlRuntime(path = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"]): FareControlRuntime {
  if (path === undefined || !isAbsolute(path)) fail();
  try { return fareControlRuntimeFromAddon(controlRecord(createRequire(import.meta.url)(path))); } catch { return fail(); }
}

export interface ControlOperationalHold extends ControlRecord {
  readonly worldId: string; readonly trainRunId: string; readonly holdId: string; readonly caseIds: readonly string[];
  readonly targetStopId: string; readonly requestedAtMs: number; readonly activatedAtMs: number | null;
  readonly deadlineMs: number | null; readonly releasedAtMs: number | null; readonly modelHash: string; readonly revision: number;
  readonly outcome: "identity_confirmed" | "identity_not_confirmed" | "unavailable" | "timeout" | "target_unavailable" | null;
}
export interface ControlOperationalHoldReceipt {
  readonly hold: ControlOperationalHold; readonly operationalStateHash: string; readonly nowMs: number;
}
export interface ConductorPoliceAdapter {
  request(tx: IdentityDatabase, context: ConductorCommittedContext, input: {
    readonly caseId: string; readonly reason: "identity_refusal" | "concrete_danger"; readonly causalityId: string;
  }): Promise<ControlOperationalHoldReceipt>;
  read(tx: IdentityDatabase, input: { readonly worldId: string; readonly operatorId: string; readonly trainRunId: string }): Promise<ControlOperationalHoldReceipt | undefined>;
  resolve(tx: IdentityDatabase, input: { readonly worldId: string; readonly operatorId: string; readonly trainRunId: string;
    readonly holdId: string; readonly expectedRevision: number; readonly modelHash: string;
    readonly outcome: "identity_confirmed" | "identity_not_confirmed" | "unavailable"; readonly causalityId: string;
  }): Promise<ControlOperationalHoldReceipt>;
}
