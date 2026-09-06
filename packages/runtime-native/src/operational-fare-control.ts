/** Reiner JSON-Transport des Kontrollhaltvertrags aus docs/conductor-hold.md. */
export const FARE_CONTROL_POLICY_SCHEMA = "zugfolge-fare-control-policy/v1" as const;
export const FARE_CONTROL_HOLD_SCHEMA = "zugfolge-fare-control-hold/v1" as const;
export const FARE_CONTROL_CAUSE = "authority.police.fare-control" as const;
export type FareControlReasonV1 = "identity_refusal" | "concrete_danger";
export type FareControlHoldStatusV1 = "requested" | "active" | "released";
export type FareControlHoldOutcomeV1 = "identity_confirmed" | "identity_not_confirmed" | "unavailable" | "timeout" | "target_unavailable";
export interface FareControlPolicyV1 {
  readonly schema: typeof FARE_CONTROL_POLICY_SCHEMA;
  readonly policyId: string;
  readonly revision: number;
  readonly worldId: string;
  readonly schedulePeriodId: string;
  readonly contentHash: string;
  readonly maxPoliceHoldsPerTrainRun: 1;
  readonly eligibleReasons: readonly FareControlReasonV1[];
  readonly targetRule: "next_unreached_scheduled_passenger_stop";
  readonly providerByStopId: Readonly<Record<string, string>>;
  readonly maxWaitMs: number;
  readonly policeResponseModelId: string;
  readonly policeResponseModelHash: string;
  readonly publicCause: typeof FARE_CONTROL_CAUSE;
}
export interface FareControlHoldV1 {
  readonly schemaVersion: typeof FARE_CONTROL_HOLD_SCHEMA;
  readonly worldId: string; readonly trainRunId: string; readonly holdId: string;
  readonly caseIds: readonly string[]; readonly targetStopId: string;
  readonly requestedAtMs: number; readonly activatedAtMs: number | null;
  readonly deadlineMs: number | null; readonly releasedAtMs: number | null;
  readonly status: FareControlHoldStatusV1; readonly outcome: FareControlHoldOutcomeV1 | null;
  readonly revision: number; readonly causalityId: string; readonly providerId: string;
  readonly policyHash: string; readonly modelHash: string; readonly policy: FareControlPolicyV1;
}
export interface RequestFareControlHoldInputV1 {
  readonly trainId: string; readonly caseId: string;
  readonly reason: FareControlReasonV1; readonly causalityId: string;
}
export interface ResolveFareControlHoldInputV1 {
  readonly trainId: string; readonly holdId: string; readonly expectedRevision: number;
  readonly modelHash: string;
  readonly outcome: "identity_confirmed" | "identity_not_confirmed" | "unavailable";
  readonly causalityId: string;
}
export interface CancelPassengerStopPlanInputV1 {
  readonly trainId: string; readonly expectedStopPlanHash: string; readonly causalityId: string;
}
export interface OperationalPassengerStopCancellation {
  readonly worldId: string; readonly trainRunId: string; readonly stopPlanHash: string;
  readonly cancelledAtMs: number; readonly causalityId: string;
}
export interface FareControlHoldEventV1 {
  readonly schemaVersion: "zugfolge-fare-control-hold-event/v1";
  readonly worldId: string; readonly trainRunId: string; readonly holdId: string;
  readonly targetStopId: string; readonly atMs: number; readonly status: FareControlHoldStatusV1;
  readonly outcome: FareControlHoldOutcomeV1 | null; readonly revision: number;
  readonly cause: typeof FARE_CONTROL_CAUSE; readonly causalityId: string;
}
export type OperationalFareControlCommand =
  | Readonly<{ type: "set-fare-control-policy"; policy: FareControlPolicyV1 }>
  | Readonly<{ type: "request-fare-control-hold"; request: RequestFareControlHoldInputV1 }>
  | Readonly<{ type: "resolve-fare-control-hold"; resolution: ResolveFareControlHoldInputV1 }>
  | Readonly<{ type: "cancel-passenger-stop-plan"; cancellation: CancelPassengerStopPlanInputV1 }>;

function require(value: unknown): asserts value {
  if (!value) throw new TypeError("Ungültiger nativer Kontrollhaltvertrag.");
}
function record(value: unknown): Record<string, unknown> {
  require(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  require(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
function id(value: unknown): asserts value is string {
  require(typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value));
}
function hash(value: unknown): asserts value is string { require(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)); }
function number(value: unknown, min = 0): asserts value is number { require(Number.isSafeInteger(value) && (value as number) >= min); }

/** Prüft den Transport; Hash, Zeit und betriebliche Regeln prüft ausschließlich Rust. */
export function assertFareControlPolicy(value: unknown, worldId?: string): asserts value is FareControlPolicyV1 {
  const row = record(value);
  exact(row, ["schema", "policyId", "revision", "worldId", "schedulePeriodId", "contentHash", "maxPoliceHoldsPerTrainRun", "eligibleReasons", "targetRule", "providerByStopId", "maxWaitMs", "policeResponseModelId", "policeResponseModelHash", "publicCause"]);
  require(row["schema"] === FARE_CONTROL_POLICY_SCHEMA && row["publicCause"] === FARE_CONTROL_CAUSE);
  for (const key of ["policyId", "worldId", "schedulePeriodId", "policeResponseModelId"]) id(row[key]);
  if (worldId !== undefined) require(row["worldId"] === worldId);
  number(row["revision"], 1); number(row["maxWaitMs"], 1); hash(row["policeResponseModelHash"]); hash(row["contentHash"]);
  require(row["maxPoliceHoldsPerTrainRun"] === 1 && row["targetRule"] === "next_unreached_scheduled_passenger_stop");
  const reasons = row["eligibleReasons"];
  require(Array.isArray(reasons) && reasons.length === 2 && reasons.includes("identity_refusal") && reasons.includes("concrete_danger"));
  const providers = record(row["providerByStopId"]);
  require(Object.keys(providers).length > 0 && Object.keys(providers).length <= 100_000);
  for (const [stop, provider] of Object.entries(providers)) { id(stop); id(provider); }
}

export function assertOperationalFareControlCommand(value: unknown, worldId?: string): void {
  const row = record(value);
  switch (row["type"]) {
    case "set-fare-control-policy":
      exact(row, ["type", "policy"]); assertFareControlPolicy(row["policy"], worldId); break;
    case "request-fare-control-hold": {
      exact(row, ["type", "request"]); const input = record(row["request"]);
      exact(input, ["trainId", "caseId", "reason", "causalityId"]);
      id(input["trainId"]); id(input["caseId"]); id(input["causalityId"]);
      require(input["reason"] === "identity_refusal" || input["reason"] === "concrete_danger"); break;
    }
    case "resolve-fare-control-hold": {
      exact(row, ["type", "resolution"]); const input = record(row["resolution"]);
      exact(input, ["trainId", "holdId", "expectedRevision", "modelHash", "outcome", "causalityId"]);
      id(input["trainId"]); id(input["holdId"]); id(input["causalityId"]); hash(input["modelHash"]); number(input["expectedRevision"], 1);
      require(["identity_confirmed", "identity_not_confirmed", "unavailable"].includes(String(input["outcome"]))); break;
    }
    case "cancel-passenger-stop-plan": {
      exact(row, ["type", "cancellation"]); const input = record(row["cancellation"]);
      exact(input, ["trainId", "expectedStopPlanHash", "causalityId"]);
      id(input["trainId"]); id(input["causalityId"]); hash(input["expectedStopPlanHash"]); break;
    }
  }
}

/** Nur die öffentlichen, bereits nativen Ereignisfelder passieren diese Grenze. */
export function decodeFareControlHoldEvent(value: unknown, worldId: string, trainRunId: string, atMs: number): FareControlHoldEventV1 {
  const row = record(value);
  exact(row, ["schemaVersion", "worldId", "trainRunId", "holdId", "targetStopId", "atMs", "status", "outcome", "revision", "cause", "causalityId"]);
  require(row["schemaVersion"] === "zugfolge-fare-control-hold-event/v1" && row["worldId"] === worldId && row["trainRunId"] === trainRunId && row["atMs"] === atMs && row["cause"] === FARE_CONTROL_CAUSE);
  for (const key of ["worldId", "trainRunId", "holdId", "targetStopId", "causalityId"]) id(row[key]);
  number(row["atMs"]); number(row["revision"], 1);
  require(["requested", "active", "released"].includes(String(row["status"])));
  require(row["outcome"] === null || ["identity_confirmed", "identity_not_confirmed", "unavailable", "timeout", "target_unavailable"].includes(String(row["outcome"])));
  require((row["status"] === "released") === (row["outcome"] !== null));
  return Object.freeze({ ...row }) as unknown as FareControlHoldEventV1;
}
