import type { DomainEvent } from "@zugfolge/db";

export const SIMULATION_EVENT_PROJECTION_SCHEMA = "zugfolge-simulation-event-projection/v1" as const;

export interface PlayerSimulationEvent {
  readonly sequence: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly visibility: "public" | "operator";
  readonly payload: unknown;
}

export interface PlayerSimulationEventBatch {
  readonly schemaVersion: typeof SIMULATION_EVENT_PROJECTION_SCHEMA;
  readonly after: number;
  /**
   * Sequenz des letzten serverseitig untersuchten Rohereignisses. Auch wenn
   * ein kompletter Batch nur interne oder fremde Events enthielt, kann der
   * Client damit deterministisch und ohne Endlosschleife fortsetzen.
   */
  readonly nextAfter: number;
  readonly events: readonly PlayerSimulationEvent[];
}

const INTERNAL_EVENT_PREFIXES = [
  "admin.",
  "commerce.",
  "command.",
  "odoo.",
  "planning.",
] as const;

/**
 * Neue Fachereignisse sind standardmaessig unsichtbar, bis ihre Projektion
 * bewusst freigegeben wurde. Ein Prefix-Wildcard wuerde spaetere interne
 * Economy- oder Dispatch-Ereignisse versehentlich oeffentlich machen.
 */
const OPERATOR_EVENT_TYPES = new Set([
  "dispatch.decision",
  "dispatch.decision-applied",
  "dispatch.major-event",
  "dispatch.manual-override",
  "disruption.applied",
  "disruption.cleared",
  "disruption.decision",
  "disruption.manual-intervention",
  "disruption.replacement-plan",
  "economy.settlement",
  "operations.train-outcome",
]);

const PUBLIC_EVENT_TYPES = new Set([
  "alpha.public-operation-visible",
  "disruption.applied",
  "disruption.cleared",
  "disruption.registered",
  "livemap-operation-cleared",
  "livemap-operation-marked",
  "simulation.delay-changed",
  "simulation.ended",
  "simulation.started",
  "simulation.time-advanced",
  "simulation.train-dematerialized",
  "simulation.train-materialized",
  // Rueckwaertskompatibler Ereignisname des ersten Eventlog-Vertrags.
  "train.materialized",
]);

const PUBLIC_PAYLOAD_FIELDS = new Set([
  "affectedResource",
  "affectedTrainRunIds",
  "atS",
  "cause",
  "causeCode",
  "delaySeconds",
  "disruptionId",
  "endsAtS",
  "id",
  "kind",
  "effect",
  "marker",
  "operatorId",
  "positionMm",
  "releaseReference",
  "startsAtS",
  "status",
  "trainId",
  "trainNumber",
  "trainRunId",
  "trainRunIds",
]);

const SENSITIVE_PAYLOAD_WORD = /(?:^|_)(?:admin|auth|authorization|command|credential|internal|keycloak|password|raw|runtime|secret|seed|session|subject|token)(?:$|_)/;

const OPERATOR_PAYLOAD_FIELDS = new Set([
  "action",
  "affectedResource",
  "affectedTrainRunIds",
  "affected_resource",
  "cause",
  "causeCode",
  "causeLabel",
  "cause_code",
  "cause_label",
  "conditions",
  "contractId",
  "contractPenaltyCents",
  "contract_id",
  "contract_penalty_cents",
  "costCents",
  "cost_cents",
  "disruptionId",
  "decision",
  "decisionId",
  "decision_id",
  "delaySeconds",
  "delay_seconds",
  "explanation",
  "effect",
  "fineCauseId",
  "fineCauseLabel",
  "fine_cause_id",
  "fine_cause_label",
  "impact",
  "limits",
  "lotId",
  "lot_id",
  "major",
  "manual",
  "manualOverride",
  "manual_override",
  "missingSeats",
  "missing_seats",
  "missedConnections",
  "missed_connections",
  "operatorId",
  "operator_id",
  "outcomeReason",
  "outcome_reason",
  "personnelEffect",
  "personnel_effect",
  "positionMm",
  "programVersion",
  "program_version",
  "rejectedAlternatives",
  "rejected_alternatives",
  "revenueCents",
  "revenue_cents",
  "releaseReference",
  "ruleId",
  "rule_id",
  "selected_action",
  "status",
  "trainId",
  "trainKm",
  "trainRunId",
  "train_id",
  "train_km",
  "train_run_id",
  "vehicleEffect",
  "vehicle_effect",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function operatorId(payload: unknown): string | undefined {
  const value = record(payload);
  if (value === undefined) return undefined;
  if (typeof value["operatorId"] === "string") return value["operatorId"];
  return typeof value["operator_id"] === "string" ? value["operator_id"] : undefined;
}

function isInternalEventType(eventType: string): boolean {
  return INTERNAL_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))
    || eventType.includes("runtime-state")
    || eventType.includes("command-payload");
}

function safePublicValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isSafeInteger(value)) {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || Number.isSafeInteger(item))) {
    return [...value];
  }
  return undefined;
}

function publicPayload(payload: unknown): Record<string, unknown> {
  const value = record(payload);
  if (value === undefined) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (!PUBLIC_PAYLOAD_FIELDS.has(key)) return [];
      const safe = safePublicValue(item);
      return safe === undefined ? [] : [[key, safe]];
    }),
  );
}

function sensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
  return SENSITIVE_PAYLOAD_WORD.test(normalized);
}

function safeOperatorValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isSafeInteger(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => safeOperatorValue(item, depth + 1)).filter((item) => item !== undefined);
  }
  const source = record(value);
  if (source === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, item]) => {
      if (sensitiveKey(key)) return [];
      const projected = safeOperatorValue(item, depth + 1);
      return projected === undefined ? [] : [[key, projected]];
    }),
  );
}

function operatorPayload(payload: unknown): Record<string, unknown> {
  const source = record(payload);
  if (source === undefined) return {};
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, item]) => {
      if (!OPERATOR_PAYLOAD_FIELDS.has(key) || sensitiveKey(key)) return [];
      const projected = safeOperatorValue(item, 1);
      return projected === undefined ? [] : [[key, projected]];
    }),
  );
}

function projectEvent(
  event: DomainEvent,
  ownedOperatorIds: ReadonlySet<string>,
): PlayerSimulationEvent | undefined {
  if (isInternalEventType(event.eventType)) return undefined;
  const owner = operatorId(event.payload);
  if (
    owner !== undefined
    && ownedOperatorIds.has(owner)
    && OPERATOR_EVENT_TYPES.has(event.eventType)
  ) {
    return {
      sequence: event.sequence,
      eventType: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
      visibility: "operator",
      payload: operatorPayload(event.payload),
    };
  }
  if (!PUBLIC_EVENT_TYPES.has(event.eventType)) return undefined;
  return {
    sequence: event.sequence,
    eventType: event.eventType,
    occurredAt: event.occurredAt.toISOString(),
    visibility: "public",
    payload: publicPayload(event.payload),
  };
}

/** Spielerprojektion ueber einen bereits begrenzten, sequenzierten Rohbatch. */
export function projectSimulationEventBatch(
  rawEvents: readonly DomainEvent[],
  ownedOperatorIds: ReadonlySet<string>,
  after: number,
): PlayerSimulationEventBatch {
  return {
    schemaVersion: SIMULATION_EVENT_PROJECTION_SCHEMA,
    after,
    nextAfter: rawEvents.at(-1)?.sequence ?? after,
    events: rawEvents.flatMap((event) => {
      const projected = projectEvent(event, ownedOperatorIds);
      return projected === undefined ? [] : [projected];
    }),
  };
}
