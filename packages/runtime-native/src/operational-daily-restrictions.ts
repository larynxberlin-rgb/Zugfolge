import type { OperationalInfrastructureBinding, OperationalDisruption } from "./operational-simulation.js";

export const OPERATIONAL_DAILY_RESTRICTIONS_SCHEMA = "zugfolge-operational-daily-restrictions/v1" as const;
export const OPERATIONAL_DAILY_RESTRICTIONS_GENERATED_SCHEMA = "zugfolge-operational-daily-restrictions-generated/v1" as const;
export const OPERATIONAL_DAY_MS = 86_400_000;

export interface OperationalDailyRestrictionPolicy {
  readonly version: number;
  readonly plannedWorksMode: "REALISTIC" | "SIMULATED" | "MANUAL";
  readonly operationalIncidentMode: "REALISTIC" | "SIMULATED" | "MANUAL";
  readonly providerSetId: string | null;
  readonly simulationProfile: Readonly<Record<string, unknown>>;
  readonly rulesetVersion: string;
  readonly validFromMs: number;
  readonly validUntilMs: number | null;
}

export interface OperationalDailyRestrictionsRequest {
  readonly schemaVersion: typeof OPERATIONAL_DAILY_RESTRICTIONS_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly seed: string;
  readonly dayStartMs: number;
  readonly infraRelease: OperationalInfrastructureBinding;
  readonly routeVersionIds: readonly string[];
  readonly policy: OperationalDailyRestrictionPolicy;
}

export interface OperationalGeneratedDailyRestriction {
  readonly disruptionId: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly effect: OperationalDisruption;
  readonly provenance: Readonly<Record<string, unknown>>;
}

export interface OperationalDailyRestrictionsGenerated {
  readonly schemaVersion: typeof OPERATIONAL_DAILY_RESTRICTIONS_GENERATED_SCHEMA;
  readonly worldId: string;
  readonly regionId: string;
  readonly dayStartMs: number;
  readonly policyVersion: number;
  readonly restrictions: readonly OperationalGeneratedDailyRestriction[];
  readonly unsupportedRestrictions: readonly Readonly<Record<string, unknown>>[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validiert nur Transport und Weltbindung; die Generatorentscheidung bleibt in Rust. */
export function decodeOperationalDailyRestrictions(
  json: string,
  request: OperationalDailyRestrictionsRequest,
): OperationalDailyRestrictionsGenerated {
  if (Buffer.byteLength(json, "utf8") > 4 * 1024 * 1024) {
    throw new Error("Nativer La-Beleg ueberschreitet das Transportbudget.");
  }
  const value: unknown = JSON.parse(json);
  if (!object(value)
    || value["schemaVersion"] !== OPERATIONAL_DAILY_RESTRICTIONS_GENERATED_SCHEMA
    || value["worldId"] !== request.worldId
    || value["regionId"] !== request.regionId
    || value["dayStartMs"] !== request.dayStartMs
    || value["policyVersion"] !== request.policy.version
    || !Array.isArray(value["restrictions"])
    || !Array.isArray(value["unsupportedRestrictions"])
    || value["restrictions"].length + value["unsupportedRestrictions"].length > 10_000) {
    throw new Error("Nativer La-Beleg verletzt Schema-, Welt-, Regions-, Tages- oder Policybindung.");
  }
  const ids = new Set<string>();
  for (const restriction of value["restrictions"]) {
    if (!object(restriction)
      || typeof restriction["disruptionId"] !== "string"
      || restriction["disruptionId"].length === 0
      || ids.has(restriction["disruptionId"])
      || restriction["startsAtMs"] !== request.dayStartMs
      || !Number.isSafeInteger(restriction["endsAtMs"])
      || (restriction["endsAtMs"] as number) <= request.dayStartMs
      || (restriction["endsAtMs"] as number) > request.dayStartMs + 2 * OPERATIONAL_DAY_MS
      || !object(restriction["effect"])
      || Object.keys(restriction["effect"]).length !== 1
      || !object(restriction["effect"]["speed-restriction"])
      || !object(restriction["provenance"])) {
      throw new Error("Nativer La-Beleg besitzt keine eindeutige, begrenzte numerische Wirkung.");
    }
    const effect = restriction["effect"]["speed-restriction"];
    if (typeof effect["edgeId"] !== "string" || effect["edgeId"].length === 0
      || !Number.isSafeInteger(effect["maximumSpeedMmps"])
      || (effect["maximumSpeedMmps"] as number) <= 0
      || (effect["maximumSpeedMmps"] as number) > 0xffff_ffff) {
      throw new Error("Nativer La-Beleg besitzt keine gueltige Geschwindigkeitsgrenze.");
    }
    ids.add(restriction["disruptionId"]);
  }
  if (!value["unsupportedRestrictions"].every(object)) {
    throw new Error("Nicht darstellbare La muessen ihre strukturierte Diagnose behalten.");
  }
  return value as unknown as OperationalDailyRestrictionsGenerated;
}
