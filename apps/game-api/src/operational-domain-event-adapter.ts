import { decodeOperationalServiceEvent } from "./operational-service-outcome.js";
import type {
  OperationalDisruption,
  OperationalProjection,
  OperationalSimulationCommandPayload,
  OperationalSimulationState,
} from "@zugfolge/runtime-native";

export const OPERATIONAL_DOMAIN_EVENT_SCHEMA =
  "zugfolge-operational-simulation-event/v2" as const;
export const OPERATIONAL_DISRUPTION_EVENT_SCHEMA =
  "zugfolge-operational-disruption-event/v2" as const;

export interface OperationalNativeEvent {
  readonly eventSequence: number;
  readonly commitSequence: number;
  readonly atMs: number;
  readonly kind: string;
  readonly subjectId: string;
  readonly detail: string;
}

export interface OperationalCommitEventContext {
  readonly commitSequence: number;
  readonly command: Extract<OperationalSimulationCommandPayload,
    { readonly type: "activate-disruption" | "clear-disruption" }>;
  readonly affectedTrainRunIds: readonly string[];
  readonly disruptionEffectBefore?: OperationalDisruption;
}

export interface AdaptedOperationalDomainEvent {
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function record(value: unknown, detail: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(detail);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[], detail: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(detail);
  }
}

function nonempty(value: unknown, detail: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(detail);
  return value;
}

function positiveInteger(value: unknown, detail: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(detail);
  return value as number;
}

function operationalDisruption(value: unknown): OperationalDisruption {
  const outer = record(value, "Operative Stoerungswirkung ist kein Objekt.");
  const keys = Object.keys(outer);
  if (keys.length !== 1) throw new TypeError("Operative Stoerungswirkung ist nicht eindeutig.");
  const kind = keys[0]!;
  const body = record(outer[kind], "Operative Stoerungswirkung besitzt keinen Objektkoerper.");
  switch (kind) {
    case "resource-closed":
    case "track-detection-failed":
      exactKeys(body, ["resourceId"], "Operative Ressourcenstoerung besitzt unbekannte Felder.");
      nonempty(body["resourceId"], "Operative Ressourcenstoerung besitzt keine Ressource.");
      break;
    case "speed-restriction":
      exactKeys(body, ["edgeId", "maximumSpeedMmps"], "Operative Langsamfahrstelle besitzt unbekannte Felder.");
      nonempty(body["edgeId"], "Operative Langsamfahrstelle besitzt keine Kante.");
      positiveInteger(body["maximumSpeedMmps"], "Operative Langsamfahrstelle besitzt keine Geschwindigkeit.");
      break;
    case "signal-failed":
      exactKeys(body, ["signalId"], "Operativer Signalausfall besitzt unbekannte Felder.");
      nonempty(body["signalId"], "Operativer Signalausfall besitzt kein Signal.");
      break;
    case "switch-failed":
      exactKeys(body, ["switchId"], "Operativer Weichenausfall besitzt unbekannte Felder.");
      nonempty(body["switchId"], "Operativer Weichenausfall besitzt keine Weiche.");
      break;
    case "vehicle-restricted":
      exactKeys(body, ["restriction", "vehicleId"], "Operative Fahrzeugstoerung besitzt unbekannte Felder.");
      nonempty(body["vehicleId"], "Operative Fahrzeugstoerung besitzt kein Fahrzeug.");
      if (body["restriction"] === undefined || body["restriction"] === null) {
        throw new TypeError("Operative Fahrzeugstoerung besitzt keine Einschraenkung.");
      }
      break;
    default:
      throw new TypeError(`Unbekannte operative Stoerungswirkung '${kind}'.`);
  }
  return structuredClone(outer) as OperationalDisruption;
}

function disruptionDescriptor(effect: OperationalDisruption): {
  readonly effect: string;
  readonly affectedResource: string;
} {
  if ("resource-closed" in effect) {
    return { effect: "closure", affectedResource: effect["resource-closed"].resourceId };
  }
  if ("speed-restriction" in effect) {
    return { effect: "speed-restriction", affectedResource: effect["speed-restriction"].edgeId };
  }
  if ("signal-failed" in effect) {
    return { effect: "signal-failure", affectedResource: effect["signal-failed"].signalId };
  }
  if ("switch-failed" in effect) {
    return { effect: "switch-failure", affectedResource: effect["switch-failed"].switchId };
  }
  if ("track-detection-failed" in effect) {
    return {
      effect: "track-detection-failure",
      affectedResource: effect["track-detection-failed"].resourceId,
    };
  }
  return {
    effect: "vehicle-restriction",
    affectedResource: effect["vehicle-restricted"].vehicleId,
  };
}

function activeDisruptionEffect(
  state: OperationalSimulationState,
  disruptionId: string,
): OperationalDisruption {
  const active = record(
    state.world["activeDisruptions"],
    "Operativer Zustand besitzt keine aktive Stoerungsmenge.",
  );
  if (!(disruptionId in active)) {
    throw new TypeError(`Aktive Stoerung '${disruptionId}' fehlt im gebundenen Vorzustand.`);
  }
  return operationalDisruption(active[disruptionId]);
}

/**
 * Verdichtet den nur fuer Stoerungsereignisse benoetigten Commitkontext
 * unmittelbar nach dem nativen Uebergang. Vollstaendiger Vorzustand und
 * Vollprojektion duerfen dadurch vor dem DB-Commit freigegeben werden.
 */
export function compactOperationalCommitEventContext(
  commitSequence: number,
  command: OperationalSimulationCommandPayload,
  stateBefore: OperationalSimulationState,
  projectionAfter: OperationalProjection,
  events: readonly OperationalNativeEvent[],
): OperationalCommitEventContext | undefined {
  const disruptionEvents = events.filter((event) =>
    event.kind === "disruption-activated" || event.kind === "disruption-cleared"
  );
  if (disruptionEvents.length === 0) return undefined;
  if (command.type !== "activate-disruption" && command.type !== "clear-disruption") {
    throw new TypeError("Operatives Stoerungsereignis besitzt kein Stoerungskommando.");
  }
  if (disruptionEvents.some((event) =>
    event.commitSequence !== commitSequence || event.subjectId !== command.disruptionId
  )) {
    throw new TypeError("Operatives Stoerungsereignis stimmt nicht mit seinem Commitkontext ueberein.");
  }
  const projectedTrainIds = new Set(projectionAfter.trains.map((train) => train.trainId));
  const affectedTrainRunIds = [...new Set(events
    .map((event) => event.subjectId)
    .filter((subjectId) => projectedTrainIds.has(subjectId)))].sort();
  return Object.freeze({
    commitSequence,
    command: structuredClone(command),
    affectedTrainRunIds: Object.freeze(affectedTrainRunIds),
    ...(command.type === "clear-disruption"
      ? { disruptionEffectBefore: activeDisruptionEffect(stateBefore, command.disruptionId) }
      : {}),
  });
}

function disruptionContext(
  event: OperationalNativeEvent,
  context: OperationalCommitEventContext | undefined,
): {
  readonly action: "apply_disruption" | "clear_disruption";
  readonly effect: OperationalDisruption;
  readonly releaseReference?: string;
} {
  if (context === undefined) {
    throw new TypeError("Operatives Stoerungsereignis besitzt keinen gebundenen Kommandokontext.");
  }
  if (event.kind === "disruption-activated") {
    if (
      context.command.type !== "activate-disruption"
      || context.command.disruptionId !== event.subjectId
    ) {
      throw new TypeError("Operatives Stoerungsereignis stimmt nicht mit seinem Aktivierungskommando ueberein.");
    }
    return {
      action: "apply_disruption",
      effect: operationalDisruption(context.command.effect),
    };
  }
  if (
    context.command.type !== "clear-disruption"
    || context.command.disruptionId !== event.subjectId
    || context.command.releaseReference !== event.detail
  ) {
    throw new TypeError("Operatives Stoerungsereignis stimmt nicht mit seinem Freigabekommando ueberein.");
  }
  if (context.disruptionEffectBefore === undefined) {
    throw new TypeError("Operative Stoerungsfreigabe besitzt keine gebundene Vorwirkung.");
  }
  return {
    action: "clear_disruption",
    effect: operationalDisruption(context.disruptionEffectBefore),
    releaseReference: context.command.releaseReference,
  };
}

/**
 * Uebersetzt native v2-Fachereignisse in das bestehende dauerhafte Eventlog.
 * Stoerungen bleiben dabei an Wirkung, Commit und explizite EVU-Empfaenger
 * gebunden; alle anderen Kernereignisse behalten ihren namespaceten Typ.
 */
export function adaptOperationalDomainEvents(
  events: readonly OperationalNativeEvent[],
  contexts: readonly OperationalCommitEventContext[],
  operatorIds: readonly string[],
  regionId: string,
  worldId?: string,
): readonly AdaptedOperationalDomainEvent[] {
  nonempty(regionId, "Operative Ereignisprojektion besitzt keine Region.");
  const contextByCommit = new Map<number, OperationalCommitEventContext>();
  for (const context of contexts) {
    if (contextByCommit.has(context.commitSequence)) {
      throw new TypeError(`Operativer Commit ${context.commitSequence} besitzt mehrere Kontexte.`);
    }
    contextByCommit.set(context.commitSequence, context);
  }
  const recipients = [...new Set(operatorIds.filter((value) => value.length > 0))].sort();

  return events.map((event) => {
    const common = {
      schemaVersion: OPERATIONAL_DOMAIN_EVENT_SCHEMA,
      nativeEventSequence: event.eventSequence,
      regionId,
      commitSequence: event.commitSequence,
      simulationTimeMs: event.atMs,
      subjectId: event.subjectId,
      detail: event.detail,
    };
    if (event.kind === "train-service-planned" || event.kind === "train-outcome") {
      const facts = decodeOperationalServiceEvent(event.kind, event.detail, event.subjectId, event.atMs, worldId);
      return Object.freeze({ eventType: `operations.${event.kind}`, payload: Object.freeze({ ...common, ...facts }) });
    }
    if (event.kind !== "disruption-activated" && event.kind !== "disruption-cleared") {
      return Object.freeze({
        eventType: `operational.${event.kind}`,
        payload: Object.freeze(common),
      });
    }
    const context = contextByCommit.get(event.commitSequence);
    const bound = disruptionContext(event, context);
    const descriptor = disruptionDescriptor(bound.effect);
    const affectedTrainRunIds = context?.affectedTrainRunIds ?? [];
    const applied = bound.action === "apply_disruption";
    return Object.freeze({
      eventType: applied ? "disruption.applied" : "disruption.cleared",
      payload: Object.freeze({
        ...common,
        schemaVersion: OPERATIONAL_DISRUPTION_EVENT_SCHEMA,
        disruptionId: event.subjectId,
        action: bound.action,
        cause: "concrete-resource-or-vehicle",
        effect: descriptor.effect,
        operationalEffect: structuredClone(bound.effect),
        affectedResource: descriptor.affectedResource,
        affectedTrainRunIds,
        trainRunIds: affectedTrainRunIds,
        operatorIds: recipients,
        impact: Object.freeze({
          affectedResource: descriptor.affectedResource,
          affectedTrainRuns: affectedTrainRunIds.length,
        }),
        ...(bound.releaseReference === undefined
          ? {}
          : { releaseReference: bound.releaseReference }),
      }),
    });
  });
}
