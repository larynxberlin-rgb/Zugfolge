import type { OperationalSimulationCommandPayload } from "@zugfolge/runtime-native";
import { compareUtf8 } from "./utf8.js";

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
  readonly effectIdempotencyKey?: string;
  readonly markEffectApplied?: () => void;
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
  readonly result?: Readonly<Record<string, unknown>>;
}

export interface ManualDisruptionSchedule {
  readonly context: ManualDisruptionAdminContext;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly targets: readonly { readonly regionId: string; readonly effect: ActivateDisruption["effect"] }[];
}

export interface ManualDisruptionAdminDependencies {
  readonly schedule: (input: ManualDisruptionSchedule) => Promise<ManualDisruptionAdminResult>;
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
    || Object.keys(target).some((key) => !["resourceId", "regionId", "maximumSpeedMmps", "vehicleRestriction"].includes(key))
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
    || value["targets"].length > 64
    || Object.keys(value).some((key) => !["schemaVersion", "kind", "causeCode", "fineCauseId", "targets"].includes(key))
  ) {
    throw new ManualDisruptionAdminError("effect");
  }
  const targets = value["targets"].map(decodeTarget).sort((left, right) =>
    compareUtf8(left.regionId, right.regionId) || compareUtf8(left.resourceId, right.resourceId));
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
  switch (effect.effect) {
    case "closure":
      if (target.maximumSpeedMmps !== undefined || target.vehicleRestriction !== undefined) throw new ManualDisruptionAdminError("effect");
      return { "resource-closed": { resourceId: target.resourceId } };
    case "speed-restriction":
      if (target.maximumSpeedMmps === undefined || target.vehicleRestriction !== undefined) throw new ManualDisruptionAdminError("effect");
      return {
        "speed-restriction": {
          edgeId: target.resourceId,
          maximumSpeedMmps: target.maximumSpeedMmps,
        },
      };
    case "vehicle-restriction":
    case "single-track":
    case "traffic-hold":
    case "route-deviation":
    case "platform-change":
    case "platform-usable-length":
      throw new ManualDisruptionAdminError("effect");
    default:
      throw new ManualDisruptionAdminError("effect");
  }
}

/** Von M13 als `manual_disruption_create`-Capability an Odoo projizierbar. */
export const MANUAL_DISRUPTION_ADMIN_CAPABILITY = Object.freeze({
  actionType: "manual_disruption_create" as const,
  availability: "available" as const,
  detail: `Wirkungsschema ${EFFECT_SCHEMA}: nur Ressourcensperre und numerische La ohne Scopeeinschraenkung; nativer Zielbeweis und dauerhafter Beginn/Ablauf.`,
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
      endsAt <= startsAt
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

    // Alle Wirkungen vor der ersten Mutation aufloesen. Der persistente
    // Scheduler entscheidet den genauen Beginn, nicht ein paralleler Worker.
    return dependencies.schedule({ context, startsAt, endsAt,
      targets: effect.targets.map((target) => ({ regionId: target.regionId, effect: concreteEffect(effect, target) })),
    });
  };
}
