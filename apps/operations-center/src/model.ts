import type { Condition, OperatingProgram, OperatingRule } from "@zugfolge/dispatch";

function normalizePriorities(rules: readonly OperatingRule[]): readonly OperatingRule[] {
  return rules.map((rule, index) => ({ ...rule, priority: (rules.length - index) * 100 }));
}

export function reorderRules(program: OperatingProgram, sourceId: string, targetId: string): OperatingProgram {
  if (sourceId === targetId) return program;
  const rules = [...program.rules];
  const source = rules.findIndex((rule) => rule.id === sourceId);
  const target = rules.findIndex((rule) => rule.id === targetId);
  if (source < 0 || target < 0) return program;
  const [moved] = rules.splice(source, 1);
  if (moved === undefined) return program;
  rules.splice(target, 0, moved);
  return { ...program, rules: normalizePriorities(rules) };
}

export function moveRule(program: OperatingProgram, id: string, offset: -1 | 1): OperatingProgram {
  const index = program.rules.findIndex((rule) => rule.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= program.rules.length) return program;
  return reorderRules(program, id, program.rules[target]!.id);
}

export function updateRule(program: OperatingProgram, id: string, update: (rule: OperatingRule) => OperatingRule): OperatingProgram {
  return { ...program, rules: program.rules.map((rule) => rule.id === id ? update(rule) : rule) };
}

function updateConditionAt(condition: Condition, path: readonly number[], update: (value: Condition) => Condition): Condition {
  if (path.length === 0) return update(condition);
  const [head, ...tail] = path;
  if ((condition.type !== "all" && condition.type !== "any") || head === undefined || condition.children[head] === undefined) return condition;
  return { ...condition, children: condition.children.map((child, index) => index === head ? updateConditionAt(child, tail, update) : child) };
}

export function updateCondition(program: OperatingProgram, ruleId: string, path: string, update: (value: Condition) => Condition): OperatingProgram {
  const indices = path === "root" ? [] : path.split(".").map(Number);
  return updateRule(program, ruleId, (rule) => ({ ...rule, condition: updateConditionAt(rule.condition, indices, update) }));
}

function removeConditionAt(condition: Condition, path: readonly number[]): Condition {
  const [head, ...tail] = path;
  if ((condition.type !== "all" && condition.type !== "any") || head === undefined) return condition;
  if (tail.length === 0) {
    if (condition.children.length <= 1) return condition;
    return { ...condition, children: condition.children.filter((_child, index) => index !== head) };
  }
  return { ...condition, children: condition.children.map((child, index) => index === head ? removeConditionAt(child, tail) : child) };
}

export function removeCondition(program: OperatingProgram, ruleId: string, path: string): OperatingProgram {
  if (path === "root") return program;
  const indices = path.split(".").map(Number);
  return updateRule(program, ruleId, (rule) => ({ ...rule, condition: removeConditionAt(rule.condition, indices) }));
}

export function addRule(program: OperatingProgram): OperatingProgram {
  let number = program.rules.length + 1;
  while (program.rules.some((rule) => rule.id === `regel-${number}`)) number += 1;
  const rule: OperatingRule = {
    id: `regel-${number}`,
    priority: 0,
    enabled: true,
    trigger: { type: "delay_threshold", at_least_seconds: 300 },
    condition: { type: "predicate", fact: "delay_seconds", comparison: "greater_or_equal", value: { type: "integer", value: 300 } },
    action: "hold_connection",
  };
  return { ...program, rules: normalizePriorities([...program.rules, rule]) };
}

export function removeRule(program: OperatingProgram, id: string): OperatingProgram {
  if (program.rules.length <= 1) return program;
  return { ...program, rules: normalizePriorities(program.rules.filter((rule) => rule.id !== id)) };
}
