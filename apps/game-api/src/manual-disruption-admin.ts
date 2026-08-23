import type { OperationalSimulationCommandPayload } from "@zugfolge/runtime-native";

const EFFECT_SCHEMA = "zugfolge-manual-disruption-effect/v1" as const;
const EFFECTS = new Set([
  "closure",
  "single-track",
  "speed-restriction",
  "platform-change",
  "traffic-hold",
  "route-deviation",
  "vehicle-restriction",
  "platform-usable-length",
]);

type ActivateDisruption = Extract<
  OperationalSimulationCommandPayload,
  { readonly type: "activate-disruption" }
>;

/** Strukturell kompatibler M13-Handlerkontext ohne Abhaengigkeit auf Commerce. */
export interface ManualDisruptionAdminContext {
  readonly commandId: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly receivedAt: Date;
  readonly now: Date;
  readonly payload: {
    readonly kind: string;
    readonly worldId: string;
    readonly actionType: string;
    readonly riskClass: string;
    readonly requesterReference: string;
    readonly approverReference?: string;
    readonly reason: string;
    readonly manualDisruption?: {
      readonly startsAt: string;
      readonly endsAt: string;
      readonly cause: string;
      readonly affectedResourceIds: readonly string[];
      readonly declaredEffect: Readonly<Record<string, unknown>>;
    };
  };
}
export interface ManualDisruptionAdminResult {
  readonly state: "completed";
  readonly gameAuditEventId: string;
}

export interface ManualDisruptionAdminWorker {
  readonly apply: (
    work: {
      readonly worldId: string;
      readonly regionId: string;
      readonly commandId: string;
      readonly command: OperationalSimulationCommandPayload;
    },
    persistedAt: Date,
  ) => Promise<unknown>;
}

export interface ManualDisruptionAdminDependencies {
  readonly worker: ManualDisruptionAdminWorker;
  /** Liefert die gepinnte Weltepoche; kein Wandzeit-Zugriff im Simulationskern. */
  readonly worldEpoch: (worldId: string) => Promise<Date> | Date;
}

export class ManualDisruptionAdminError extends Error {
  constructor(readonly code: "authorization" | "schema" | "time" | "resources" | "effect") {
    super(`Manuelle Stoerung wurde abgelehnt: ${code}.`);
    this.name = "ManualDisruptionAdminError";
  }
}

interface Target {
  readonly resourceId: string;
  readonly regionId: string;
  readonly maximumSpeedMmps?: number;
  readonly vehicleRestriction?: unknown;
}

interface DecodedEffect {
  readonly effect: string;
  readonly causeCode: number;
  readonly fineCauseId: string;
  readonly targets: readonly Target[];
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManualDisruptionAdminError("schema");
  }
  return value as Readonly<Record<string, unknown>>;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function decodeTarget(value: unknown): Target {
  const target = record(value);
  if (
    !nonempty(target["resourceId"]) ||
    !nonempty(target["regionId"])
  ) {
    throw new ManualDisruptionAdminError("resources");
  }
  if (
    target["maximumSpeedMmps"] !== undefined
    && (
      !Number.isSafeInteger(target["maximumSpeedMmps"])
      || (target["maximumSpeedMmps"] as number) <= 0
      || (target["maximumSpeedMmps"] as number) > 0xffff_ffff
    )
  ) {
    throw new ManualDisruptionAdminError("resources");
  }
  return {
    resourceId: target["resourceId"],
    regionId: target["regionId"],
    ...(target["maximumSpeedMmps"] === undefined
      ? {}
      : { maximumSpeedMmps: target["maximumSpeedMmps"] as number }),
    ...(target["vehicleRestriction"] === undefined
      ? {}
      : { vehicleRestriction: target["vehicleRestriction"] }),
  };
}

function decodeEffect(value: Readonly<Record<string, unknown>>): DecodedEffect {
  if (
    value["schemaVersion"] !== EFFECT_SCHEMA ||
    !nonempty(value["kind"]) ||
    !EFFECTS.has(value["kind"]) ||
    !Number.isSafeInteger(value["causeCode"]) ||
    (value["causeCode"] as number) < 10 ||
    (value["causeCode"] as number) > 90 ||
    !nonempty(value["fineCauseId"]) ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value["fineCauseId"]) ||
    !Array.isArray(value["targets"]) ||
    value["targets"].length === 0
  ) {
    throw new ManualDisruptionAdminError("effect");
  }
  const targets = value["targets"].map(decodeTarget).sort((left, right) =>
    left.regionId.localeCompare(right.regionId) || left.resourceId.localeCompare(right.resourceId));
  if (new Set(targets.map((target) => target.resourceId)).size !== targets.length) {
    throw new ManualDisruptionAdminError("resources");
  }
  return {
    effect: value["kind"],
    causeCode: value["causeCode"] as number,
    fineCauseId: value["fineCauseId"],
    targets,
  };
}

function concreteEffect(effect: DecodedEffect, target: Target): ActivateDisruption["effect"] {
  if (target.resourceId.startsWith("signal:")) {
    return { "signal-failed": { signalId: target.resourceId } };
  }
  if (target.resourceId.startsWith("switch:")) {
    return { "switch-failed": { switchId: target.resourceId } };
  }
  if (effect.fineCauseId === "signalling.track-occupation") {
    return { "track-detection-failed": { resourceId: target.resourceId } };
  }
  switch (effect.effect) {
    case "closure":
    case "single-track":
    case "traffic-hold":
    case "route-deviation":
      return { "resource-closed": { resourceId: target.resourceId } };
    case "speed-restriction":
      if (target.maximumSpeedMmps === undefined) throw new ManualDisruptionAdminError("effect");
      return {
        "speed-restriction": {
          edgeId: target.resourceId,
          maximumSpeedMmps: target.maximumSpeedMmps,
        },
      };
    case "vehicle-restriction":
      if (target.vehicleRestriction === undefined) throw new ManualDisruptionAdminError("effect");
      return {
        "vehicle-restricted": {
          vehicleId: target.resourceId,
          restriction: target.vehicleRestriction,
        },
      };
    case "platform-change":
    case "platform-usable-length":
      throw new ManualDisruptionAdminError("effect");
    default:
      throw new ManualDisruptionAdminError("effect");
  }
}

function secondsSinceEpoch(value: Date, epoch: Date): number {
  const seconds = Math.floor((value.getTime() - epoch.getTime()) / 1_000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new ManualDisruptionAdminError("time");
  }
  return seconds;
}

/** Von M13 als `manual_disruption_create`-Capability an Odoo projizierbar. */
export const MANUAL_DISRUPTION_ADMIN_CAPABILITY = Object.freeze({
  actionType: "manual_disruption_create" as const,
  availability: "available" as const,
  detail: `M8.3 aktiv; Wirkungsschema ${EFFECT_SCHEMA}; Game-Pruefung bleibt autoritativ.`,
});

/**
 * Baut den fachlichen Single-Writer-Handler fuer die persistente Odoo-Queue.
 * Signatur, Replay-Schutz und Workflow kommen aus M13; dieser Handler prueft
 * erneut Vier-Augen-Prinzip, Weltzeit, Ressourcen und konkrete Spielwirkung.
 */
export function createManualDisruptionAdminHandler(
  dependencies: ManualDisruptionAdminDependencies,
): (context: ManualDisruptionAdminContext) => Promise<ManualDisruptionAdminResult> {
  return async (context) => {
    const { payload } = context;
    if (
      payload.kind !== "admin.manual_disruption_create" ||
      payload.actionType !== "manual_disruption_create" ||
      payload.riskClass !== "high" ||
      !nonempty(payload.requesterReference) ||
      !nonempty(payload.approverReference) ||
      payload.requesterReference === payload.approverReference ||
      !nonempty(payload.reason)
    ) {
      throw new ManualDisruptionAdminError("authorization");
    }
    const manual = payload.manualDisruption;
    if (
      manual === undefined ||
      !nonempty(manual.cause) ||
      !Array.isArray(manual.affectedResourceIds) ||
      manual.affectedResourceIds.length === 0 ||
      !manual.affectedResourceIds.every(nonempty)
    ) {
      throw new ManualDisruptionAdminError("schema");
    }
    const startsAt = new Date(manual.startsAt);
    const endsAt = new Date(manual.endsAt);
    if (
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime()) ||
      endsAt <= startsAt ||
      endsAt <= context.now
    ) {
      throw new ManualDisruptionAdminError("time");
    }
    const effect = decodeEffect(manual.declaredEffect);
    const requestedResources = [...new Set(manual.affectedResourceIds)].sort();
    if (
      requestedResources.length !== manual.affectedResourceIds.length ||
      requestedResources.join("\u0000") !== effect.targets.map((target) => target.resourceId).sort().join("\u0000")
    ) {
      throw new ManualDisruptionAdminError("resources");
    }

    const epoch = await dependencies.worldEpoch(payload.worldId);
    if (Number.isNaN(epoch.getTime())) throw new ManualDisruptionAdminError("time");
    const nowS = secondsSinceEpoch(context.now, epoch);
    const requestedStartS = secondsSinceEpoch(startsAt, epoch);
    const validUntilS = secondsSinceEpoch(endsAt, epoch);
    if (requestedStartS > nowS || validUntilS <= nowS) throw new ManualDisruptionAdminError("time");

    for (const [index, target] of effect.targets.entries()) {
      const disruptionId = `admin:${context.commandId}:${index}`;
      await dependencies.worker.apply({
        worldId: payload.worldId,
        regionId: target.regionId,
        commandId: `odoo-manual-disruption:${context.eventId}:${index}`,
        command: {
          type: "activate-disruption",
          disruptionId,
          effect: concreteEffect(effect, target),
        },
      }, context.now);
    }
    return {
      state: "completed",
      gameAuditEventId: `manual-disruption:${payload.worldId}:${context.commandId}`,
    };
  };
}
