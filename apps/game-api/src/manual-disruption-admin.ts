import type { RegionalSimulationCommandPayload } from "@zugfolge/runtime-native";

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

type RegisterDisruption = Extract<
  RegionalSimulationCommandPayload,
  { readonly type: "register-disruption" }
>["disruption"];

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
      readonly command: RegionalSimulationCommandPayload;
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
  readonly positionMm: number;
  readonly affectedTrainRunIds: readonly string[];
}

interface DecodedEffect {
  readonly effect: RegisterDisruption["effect"];
  readonly causeCode: number;
  readonly fineCauseId: string;
  readonly delaySeconds: number;
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
    !nonempty(target["regionId"]) ||
    !Number.isSafeInteger(target["positionMm"]) ||
    (target["positionMm"] as number) < 0 ||
    !Array.isArray(target["affectedTrainRunIds"]) ||
    target["affectedTrainRunIds"].length === 0 ||
    !target["affectedTrainRunIds"].every(nonempty)
  ) {
    throw new ManualDisruptionAdminError("resources");
  }
  const trainRunIds = [...new Set(target["affectedTrainRunIds"] as string[])].sort();
  if (trainRunIds.length !== target["affectedTrainRunIds"].length) {
    throw new ManualDisruptionAdminError("resources");
  }
  return {
    resourceId: target["resourceId"],
    regionId: target["regionId"],
    positionMm: target["positionMm"] as number,
    affectedTrainRunIds: trainRunIds,
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
    !Number.isSafeInteger(value["delaySeconds"]) ||
    (value["delaySeconds"] as number) < 1 ||
    (value["delaySeconds"] as number) > 604_800 ||
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
    effect: value["kind"] as RegisterDisruption["effect"],
    causeCode: value["causeCode"] as number,
    fineCauseId: value["fineCauseId"],
    delaySeconds: value["delaySeconds"] as number,
    targets,
  };
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
    const startsAtS = Math.max(nowS, requestedStartS);
    if (validUntilS <= startsAtS) throw new ManualDisruptionAdminError("time");

    for (const [index, target] of effect.targets.entries()) {
      const disruption: RegisterDisruption = {
        disruptionId: `admin:${context.commandId}:${index}`,
        kind: requestedStartS > nowS ? "planned" : "unplanned",
        publishedAtS: nowS,
        startsAtS,
        validUntilS,
        positionMm: target.positionMm,
        causeCode: effect.causeCode,
        fineCauseId: effect.fineCauseId,
        effect: effect.effect,
        affectedResource: target.resourceId,
        affectedTrainRunIds: target.affectedTrainRunIds,
        delaySeconds: effect.delaySeconds,
      };
      await dependencies.worker.apply({
        worldId: payload.worldId,
        regionId: target.regionId,
        commandId: `odoo-manual-disruption:${context.eventId}:${index}`,
        command: { type: "register-disruption", disruption },
      }, context.now);
    }
    return {
      state: "completed",
      gameAuditEventId: `manual-disruption:${payload.worldId}:${context.commandId}`,
    };
  };
}
