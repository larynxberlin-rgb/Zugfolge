export interface LoggedEvent {
  readonly sequence: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
}

export interface OperationsDecision {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly trainRunId: string;
  readonly decisionId: string;
  readonly action: string;
  readonly cause: string;
  readonly affectedResource: string;
  readonly outcomeReason: string;
  readonly impact: Record<string, unknown>;
  readonly raw: Record<string, unknown>;
}

export interface OperationsProjection {
  readonly throughSequence: number;
  readonly decisions: readonly OperationsDecision[];
  readonly cancellations: readonly OperationsDecision[];
  readonly manualInterventions: readonly OperationsDecision[];
  readonly majorEvents: readonly OperationsDecision[];
}

/** Ab dieser Zahl betroffener Zugläufe wird eine Entscheidung als Großereignis hervorgehoben. */
export const MAJOR_DISRUPTION_AFFECTED_TRAIN_RUNS = 3;

export interface DailyDecisionFact {
  readonly eventSequence: number;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly decisionId: string;
  readonly trainRunId: string;
  readonly programVersion: number | null;
  readonly ruleId: string;
  readonly action: string;
  readonly conditions: readonly unknown[];
  readonly limits: readonly unknown[];
  readonly rejectedAlternatives: readonly unknown[];
  readonly manualOverride: boolean;
  readonly outcomeReason: string;
  readonly impact: Readonly<Record<string, unknown>>;
}

export interface DailyOperationsReport {
  readonly schema: "daily-operations-report/v1";
  readonly serviceDay: string;
  readonly sourceFromSequence: number;
  readonly sourceThroughSequence: number;
  readonly trainRuns: { readonly total: number; readonly punctual: number; readonly delayed: number; readonly cancelled: number; readonly replacementServices: number };
  readonly settlements: { readonly revenueCents: string; readonly costCents: string; readonly contractPenaltyCents: string };
  readonly decisionsByAction: Readonly<Record<string, number>>;
  readonly infrastructureEffects: readonly string[];
  readonly personnelEffects: readonly string[];
  readonly vehicleEffects: readonly string[];
  /** Unveränderliche Tatsachen mit Sequenzen als Linkziel ins zugrunde liegende Event-Log. */
  readonly facts: {
    readonly eventSequences: readonly number[];
    readonly decisions: readonly DailyDecisionFact[];
  };
  /** Deterministisch aus den Tatsachen abgeleitete Hinweise, ausdrücklich keine Ereignisse. */
  readonly assessment: { readonly nextLevers: readonly string[] };
}

function payload(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function operatorMatches(value: Record<string, unknown>, operatorId: string): boolean {
  return value.operatorId === operatorId || value.operator_id === operatorId;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function decision(event: LoggedEvent, value: Record<string, unknown>): OperationsDecision {
  const impact = payload(value.impact) ?? {};
  return {
    sequence: event.sequence,
    occurredAt: event.occurredAt.toISOString(),
    trainRunId: text(value.trainRunId ?? value.train_run_id),
    decisionId: String(value.decisionId ?? value.decision_id ?? event.sequence),
    action: text(value.action ?? value.selected_action ?? value.decision),
    cause: text(value.cause ?? impact.cause),
    affectedResource: text(value.affectedResource ?? value.affected_resource ?? impact.affected_resource),
    outcomeReason: text(value.outcomeReason ?? value.outcome_reason),
    impact,
    raw: value,
  };
}

export function projectOperations(events: readonly LoggedEvent[], operatorId: string): OperationsProjection {
  const decisions: OperationsDecision[] = [];
  for (const event of events) {
    const value = payload(event.payload);
    if (value === undefined || !operatorMatches(value, operatorId)) continue;
    if (event.eventType === "dispatch.decision" || event.eventType === "dispatch.major-event" || event.eventType === "dispatch.manual-override") decisions.push(decision(event, value));
  }
  return {
    throughSequence: events.at(-1)?.sequence ?? 0,
    decisions,
    cancellations: decisions.filter((entry) => ["cancel_run", "cancel", "trigger_rail_replacement"].includes(entry.action)),
    manualInterventions: decisions.filter((entry) => entry.raw.manualOverride === true || entry.raw.manual_override === true || entry.raw.manual === true),
    majorEvents: decisions.filter((entry) =>
      entry.raw.major === true ||
      Number(entry.impact.affected_train_runs ?? 0) >= MAJOR_DISRUPTION_AFFECTED_TRAIN_RUNS
    ),
  };
}

function addBigInt(current: bigint, value: unknown): bigint {
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return current + BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return current + BigInt(value);
  return current;
}

function unique(values: string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function buildDailyReport(events: readonly LoggedEvent[], operatorId: string, serviceDay: string): DailyOperationsReport {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDay)) throw new RangeError("Betriebstag muss YYYY-MM-DD entsprechen.");
  const selected = events.filter((event) => event.occurredAt.toISOString().slice(0, 10) === serviceDay).filter((event) => {
    const value = payload(event.payload);
    return value !== undefined && operatorMatches(value, operatorId);
  });
  let total = 0;
  let punctual = 0;
  let delayed = 0;
  let cancelled = 0;
  let replacementServices = 0;
  let revenueCents = 0n;
  let costCents = 0n;
  let contractPenaltyCents = 0n;
  const decisionsByAction: Record<string, number> = {};
  const infrastructureEffects: string[] = [];
  const personnelEffects: string[] = [];
  const vehicleEffects: string[] = [];
  const decisionFacts: DailyDecisionFact[] = [];
  for (const event of selected) {
    const value = payload(event.payload)!;
    const impact = payload(value.impact) ?? {};
    if (event.eventType === "operations.train-outcome") {
      total += 1;
      const status = text(value.status);
      if (status === "cancelled") cancelled += 1;
      else if (Number(value.delaySeconds ?? value.delay_seconds ?? 0) <= 300) punctual += 1;
      else delayed += 1;
    }
    if (event.eventType === "dispatch.decision" || event.eventType === "dispatch.major-event" || event.eventType === "dispatch.manual-override") {
      const action = text(value.action ?? value.selected_action ?? value.decision) || "unbekannt";
      const explanation = payload(value.explanation) ?? value;
      decisionsByAction[action] = (decisionsByAction[action] ?? 0) + 1;
      if (action === "trigger_rail_replacement") replacementServices += 1;
      infrastructureEffects.push(text(value.affectedResource ?? value.affected_resource ?? impact.affected_resource));
      personnelEffects.push(text(value.personnelEffect ?? value.personnel_effect ?? impact.personnel_effect));
      vehicleEffects.push(text(value.vehicleEffect ?? value.vehicle_effect ?? impact.vehicle_effect));
      costCents = addBigInt(costCents, impact.cost_cents ?? impact.costCents);
      contractPenaltyCents = addBigInt(contractPenaltyCents, impact.contract_penalty_cents ?? impact.contractPenaltyCents);
      decisionFacts.push({
        eventSequence: event.sequence,
        occurredAt: event.occurredAt.toISOString(),
        eventType: event.eventType,
        decisionId: String(value.decisionId ?? value.decision_id ?? explanation.decision_id ?? event.sequence),
        trainRunId: text(value.trainRunId ?? value.train_run_id ?? explanation.train_run_id),
        programVersion: integerOrNull(value.programVersion ?? value.program_version ?? explanation.program_version),
        ruleId: text(value.ruleId ?? value.rule_id ?? explanation.selected_rule_id),
        action,
        conditions: list(value.conditions ?? explanation.conditions),
        limits: list(value.limits ?? explanation.limits),
        rejectedAlternatives: list(value.rejectedAlternatives ?? value.rejected_alternatives ?? explanation.rejected_alternatives),
        manualOverride: value.manualOverride === true || value.manual_override === true || value.manual === true || explanation.manual_override === true,
        outcomeReason: text(value.outcomeReason ?? value.outcome_reason ?? explanation.outcome_reason),
        impact,
      });
    }
    if (event.eventType === "economy.settlement") {
      revenueCents = addBigInt(revenueCents, value.revenueCents ?? value.revenue_cents);
      costCents = addBigInt(costCents, value.costCents ?? value.cost_cents);
      contractPenaltyCents = addBigInt(contractPenaltyCents, value.contractPenaltyCents ?? value.contract_penalty_cents);
    }
  }
  const nextLevers: string[] = [];
  if (cancelled > 0) nextLevers.push("Ausfallregeln und sichere Ersatzmaßnahmen im Rücktest vergleichen.");
  if (delayed > 0) nextLevers.push("Verspätungsschwellen und Anschlussprioritäten im Rücktest vergleichen.");
  if (decisionFacts.some((entry) => entry.rejectedAlternatives.length > 0)) nextLevers.push("Abgelehnte Maßnahmen an den protokollierten Betriebsgrenzen prüfen.");
  if (decisionFacts.some((entry) => entry.manualOverride)) nextLevers.push("Manuellen Einzelfall als mögliche, weiterhin grenzgeprüfte Regelanpassung bewerten.");
  if (contractPenaltyCents !== 0n) nextLevers.push("Vertragswirkung der häufigsten Maßnahme im Rücktest prüfen.");
  if (nextLevers.length === 0) nextLevers.push("Kein unmittelbarer Regelhebel; aktive Programmversion weiter beobachten.");
  return {
    schema: "daily-operations-report/v1",
    serviceDay,
    sourceFromSequence: selected[0]?.sequence ?? 0,
    sourceThroughSequence: selected.at(-1)?.sequence ?? 0,
    trainRuns: { total, punctual, delayed, cancelled, replacementServices },
    settlements: { revenueCents: revenueCents.toString(), costCents: costCents.toString(), contractPenaltyCents: contractPenaltyCents.toString() },
    decisionsByAction: Object.fromEntries(Object.entries(decisionsByAction).sort(([left], [right]) => left.localeCompare(right))),
    infrastructureEffects: unique(infrastructureEffects),
    personnelEffects: unique(personnelEffects),
    vehicleEffects: unique(vehicleEffects),
    facts: { eventSequences: selected.map((event) => event.sequence), decisions: decisionFacts },
    assessment: { nextLevers },
  };
}
