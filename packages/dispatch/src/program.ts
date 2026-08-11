import { createHash } from "node:crypto";

export const OPERATING_PROGRAM_SCHEMA = "operating-program/v1";

export const TRIGGERS = [
  "delay_threshold", "connection_risk", "vehicle_failure", "personnel_duty_exceeded",
  "route_closure", "platform_change", "turnaround_shortfall", "ad_hoc_path_conflict",
] as const;
export const ACTIONS = [
  "hold_connection", "break_connection", "skip_stop", "short_turn", "shorten_train",
  "strengthen_train", "cancel_run", "activate_reserve_rotation", "provide_replacement_vehicle",
  "request_reroute", "return_path", "trigger_rail_replacement",
] as const;
export const FACTS = [
  "delay_seconds", "connection_threatened", "vehicle_failed", "duty_excess_seconds", "route_closed",
  "platform_changed", "turnaround_shortfall_seconds", "ad_hoc_conflict", "affected_train_runs", "cost_cents",
] as const;
export const COMPARISONS = ["equal", "not_equal", "greater_or_equal", "less_or_equal"] as const;

export type TriggerName = (typeof TRIGGERS)[number];
export type ActionName = (typeof ACTIONS)[number];
export type FactName = (typeof FACTS)[number];
export type ComparisonName = (typeof COMPARISONS)[number];

export type RuleTrigger =
  | { readonly type: "delay_threshold"; readonly at_least_seconds: number }
  | { readonly type: Exclude<TriggerName, "delay_threshold"> };

export type FactValue =
  | { readonly type: "integer"; readonly value: number }
  | { readonly type: "boolean"; readonly value: boolean };

export type Condition =
  | { readonly type: "all" | "any"; readonly children: readonly Condition[] }
  | { readonly type: "not"; readonly child: Condition }
  | { readonly type: "predicate"; readonly fact: FactName; readonly comparison: ComparisonName; readonly value: FactValue };

export interface OperatingRule {
  readonly id: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly trigger: RuleTrigger;
  readonly condition: Condition;
  readonly action: ActionName;
}

export interface OperatingProgram {
  readonly schema: typeof OPERATING_PROGRAM_SCHEMA;
  readonly world_id: string;
  readonly operator_id: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly rules: readonly OperatingRule[];
}

export interface CanonicalProgram {
  readonly program: OperatingProgram;
  readonly canonicalJson: string;
  readonly checksum: string;
}

export class ProgramValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramValidationError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProgramValidationError(`${label} muss ein Objekt sein.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ProgramValidationError(`${label} enthält unbekannte oder fehlende Felder.`);
  }
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new ProgramValidationError(`${label} ist keine gültige Ganzzahl.`);
  return value as number;
}

function condition(input: unknown, depth = 0, counter = { value: 0 }): Condition {
  if (depth > 8 || ++counter.value > 64) throw new ProgramValidationError("Bedingungsbaum überschreitet die Komplexitätsgrenze.");
  const value = record(input, "Bedingung");
  if (value.type === "all" || value.type === "any") {
    exactKeys(value, ["type", "children"], "Bedingungsgruppe");
    if (!Array.isArray(value.children) || value.children.length === 0) throw new ProgramValidationError("Bedingungsgruppe darf nicht leer sein.");
    return { type: value.type, children: value.children.map((child) => condition(child, depth + 1, counter)) };
  }
  if (value.type === "not") {
    exactKeys(value, ["type", "child"], "Negation");
    return { type: "not", child: condition(value.child, depth + 1, counter) };
  }
  if (value.type !== "predicate") throw new ProgramValidationError("Unbekannter Bedingungstyp.");
  exactKeys(value, ["type", "fact", "comparison", "value"], "Prädikat");
  if (!FACTS.includes(value.fact as FactName) || !COMPARISONS.includes(value.comparison as ComparisonName)) throw new ProgramValidationError("Unbekanntes Faktum oder Vergleich.");
  const factValue = record(value.value, "Prädikatswert");
  exactKeys(factValue, ["type", "value"], "Prädikatswert");
  const booleanFact = ["connection_threatened", "vehicle_failed", "route_closed", "platform_changed", "ad_hoc_conflict"].includes(value.fact as string);
  if (booleanFact) {
    if (factValue.type !== "boolean" || typeof factValue.value !== "boolean" || !["equal", "not_equal"].includes(value.comparison as string)) throw new ProgramValidationError("Boolesches Faktum braucht booleschen Gleichheitsvergleich.");
  } else if (factValue.type !== "integer" || !Number.isSafeInteger(factValue.value)) {
    throw new ProgramValidationError("Ganzzahliges Faktum braucht ganzzahligen Wert.");
  }
  return value as unknown as Condition;
}

function trigger(input: unknown): RuleTrigger {
  const value = record(input, "Trigger");
  if (!TRIGGERS.includes(value.type as TriggerName)) throw new ProgramValidationError("Unbekannter Trigger.");
  if (value.type === "delay_threshold") {
    exactKeys(value, ["type", "at_least_seconds"], "Verspätungstrigger");
    return { type: "delay_threshold", at_least_seconds: integer(value.at_least_seconds, "Verspätungsschwelle", 1, 86_400) };
  }
  exactKeys(value, ["type"], "Trigger");
  return { type: value.type as Exclude<TriggerName, "delay_threshold"> };
}

export function canonicalizeProgram(input: unknown, scope: { readonly worldId: string; readonly operatorId: string }): CanonicalProgram {
  const value = record(input, "Betriebsprogramm");
  exactKeys(value, ["schema", "world_id", "operator_id", "version", "enabled", "rules"], "Betriebsprogramm");
  if (value.schema !== OPERATING_PROGRAM_SCHEMA || value.world_id !== scope.worldId || value.operator_id !== scope.operatorId) throw new ProgramValidationError("Schema oder Welt-/EVU-Bindung ist ungültig.");
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > 256) throw new ProgramValidationError("Betriebsprogramm ist leer oder zu groß.");
  const seen = new Set<string>();
  const rules = value.rules.map((candidate, index): OperatingRule => {
    const rule = record(candidate, `Regel ${index + 1}`);
    exactKeys(rule, ["id", "priority", "enabled", "trigger", "condition", "action"], "Regel");
    if (typeof rule.id !== "string" || !/^[a-z0-9_.-]{1,96}$/.test(rule.id) || seen.has(rule.id)) throw new ProgramValidationError("Regel-ID ist ungültig oder doppelt.");
    seen.add(rule.id);
    if (typeof rule.enabled !== "boolean" || !ACTIONS.includes(rule.action as ActionName)) throw new ProgramValidationError("Regelstatus oder Maßnahme ist ungültig.");
    return {
      id: rule.id,
      priority: integer(rule.priority, "Priorität", -1_000_000, 1_000_000),
      enabled: rule.enabled,
      trigger: trigger(rule.trigger),
      condition: condition(rule.condition),
      action: rule.action as ActionName,
    };
  }).sort((left, right) => right.priority - left.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const program: OperatingProgram = {
    schema: OPERATING_PROGRAM_SCHEMA,
    world_id: scope.worldId,
    operator_id: scope.operatorId,
    version: integer(value.version, "Version", 1, 2_147_483_647),
    enabled: value.enabled,
    rules,
  };
  const canonicalJson = JSON.stringify(program);
  return { program, canonicalJson, checksum: createHash("sha256").update(canonicalJson).digest("hex") };
}
