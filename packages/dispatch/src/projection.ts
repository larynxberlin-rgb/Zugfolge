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
  readonly causeCode: number | null;
  readonly causeLabel: string;
  readonly fineCauseId: string;
  readonly fineCauseLabel: string;
  readonly affectedResource: string;
  readonly outcomeReason: string;
  readonly impact: Readonly<Record<string, string | number | boolean | null>>;
  readonly manualOverride: boolean;
  readonly major: boolean;
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

export const OPERATIONS_DECISION_EVENT_TYPES = [
  "dispatch.decision",
  "dispatch.major-event",
  "dispatch.manual-override",
  "disruption.decision",
  "disruption.replacement-plan",
  "disruption.manual-intervention",
  "disruption.construction-published",
  "disruption.provider-failed",
  "disruption.applied",
] as const;

const DECISION_EVENT_TYPES = new Set<string>(OPERATIONS_DECISION_EVENT_TYPES);

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
  readonly trainRuns: {
    readonly total: number;
    readonly punctual: number;
    readonly delayed: number;
    readonly cancelled: number;
    readonly replacementServices: number;
    /** Autoritativ vom Runtime-Ereignis gemeldete, ganzzahlige Zugkilometer. */
    readonly trainKm: string;
    readonly missingSeats: number;
    readonly missedConnections: number;
  };
  readonly settlements: { readonly revenueCents: string; readonly costCents: string; readonly contractPenaltyCents: string };
  /** Vertrag-/Los-spezifische Teilmenge; verhindert Abrechnung fremder Leistungen. */
  readonly contracts: Readonly<Record<string, {
    readonly trainRuns: { readonly total: number; readonly punctual: number; readonly cancelled: number; readonly trainKm: string; readonly missingSeats: number; readonly missedConnections: number };
    readonly settlements: { readonly costCents: string; readonly contractPenaltyCents: string };
  }>>;
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
  return value.operatorId === operatorId
    || value.operator_id === operatorId
    || (Array.isArray(value.operatorIds) && value.operatorIds.includes(operatorId))
    || (Array.isArray(value.operator_ids) && value.operator_ids.includes(operatorId));
}

/**
 * Liefert genau die explizit an ein Ereignis gebundenen EVUs. Der Replaypfad
 * darf niemals alle bekannten EVUs einer Welt ausprobieren oder Ereignisse
 * ueber Weltgrenzen hinweg projizieren.
 */
export function operationsEventOperatorIds(event: Pick<LoggedEvent, "payload">): readonly string[] {
  const value = payload(event.payload);
  if (value === undefined) return [];
  const candidates = [
    value.operatorId,
    value.operator_id,
    ...(Array.isArray(value.operatorIds) ? value.operatorIds : []),
    ...(Array.isArray(value.operator_ids) ? value.operator_ids : []),
  ];
  return [...new Set(candidates.filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  ))].sort();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function causeCode(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 99
    ? value
    : null;
}

const OPERATION_IMPACT_FIELDS = new Set([
  "affectedConnections",
  "affectedPersonnelPools",
  "affectedResource",
  "affectedRotations",
  "affectedTrainRuns",
  "affectedVehicles",
  "affected_connections",
  "affected_personnel_pools",
  "affected_resource",
  "affected_rotations",
  "affected_train_runs",
  "affected_vehicles",
  "cancelledStops",
  "cancelled_stops",
  "cause",
  "contractEffect",
  "contractPenaltyCents",
  "contract_effect",
  "contract_penalty_cents",
  "costCents",
  "cost_cents",
  "personnelEffect",
  "personnel_effect",
  "vehicleEffect",
  "vehicle_effect",
]);

function projectedImpact(value: unknown): Readonly<Record<string, string | number | boolean | null>> {
  const source = payload(value);
  if (source === undefined) return {};
  return Object.fromEntries(Object.entries(source).flatMap(([key, item]) =>
    OPERATION_IMPACT_FIELDS.has(key)
    && (item === null || typeof item === "string" || typeof item === "boolean" || Number.isSafeInteger(item))
      ? [[key, item as string | number | boolean | null]]
      : [],
  ));
}

function decision(event: LoggedEvent, value: Record<string, unknown>): OperationsDecision {
  const impact = projectedImpact(value.impact);
  const manualOverride = value.manualOverride === true || value.manual_override === true || value.manual === true;
  const affectedTrainRuns = Number(impact["affected_train_runs"] ?? impact["affectedTrainRuns"] ?? 0);
  return {
    sequence: event.sequence,
    occurredAt: event.occurredAt.toISOString(),
    trainRunId: text(value.trainRunId ?? value.train_run_id),
    decisionId: String(value.decisionId ?? value.decision_id ?? event.sequence),
    action: text(value.action ?? value.selected_action ?? value.decision),
    cause: text(value.cause ?? impact.cause),
    causeCode: causeCode(value.causeCode ?? value.cause_code ?? impact.cause_code),
    causeLabel: text(value.causeLabel ?? value.cause_label ?? impact.cause_label),
    fineCauseId: text(value.fineCauseId ?? value.fine_cause_id ?? impact.fine_cause_id),
    fineCauseLabel: text(value.fineCauseLabel ?? value.fine_cause_label ?? impact.fine_cause_label),
    affectedResource: text(value.affectedResource ?? value.affected_resource ?? impact.affected_resource),
    outcomeReason: text(value.outcomeReason ?? value.outcome_reason),
    impact,
    manualOverride,
    major: value.major === true || affectedTrainRuns >= MAJOR_DISRUPTION_AFFECTED_TRAIN_RUNS,
  };
}

export function projectOperations(events: readonly LoggedEvent[], operatorId: string): OperationsProjection {
  const decisions: OperationsDecision[] = [];
  for (const event of events) {
    const value = payload(event.payload);
    if (value === undefined || !operatorMatches(value, operatorId)) continue;
    if (DECISION_EVENT_TYPES.has(event.eventType)) decisions.push(decision(event, value));
  }
  return {
    throughSequence: events.at(-1)?.sequence ?? 0,
    decisions,
    cancellations: decisions.filter((entry) => ["cancel_run", "cancel", "trigger_rail_replacement"].includes(entry.action)),
    manualInterventions: decisions.filter((entry) => entry.manualOverride),
    majorEvents: decisions.filter((entry) => entry.major),
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
  let trainKm = 0n;
  let missingSeats = 0;
  let missedConnections = 0;
  let revenueCents = 0n;
  let costCents = 0n;
  let contractPenaltyCents = 0n;
  const contractEvidence = new Map<string, {
    total: number; punctual: number; cancelled: number; trainKm: bigint; missingSeats: number; missedConnections: number;
    costCents: bigint; contractPenaltyCents: bigint;
  }>();
  const evidenceFor = (value: Readonly<Record<string, unknown>>) => {
    const reference = text(value.contractId ?? value.contract_id ?? value.lotId ?? value.lot_id);
    if (reference === "") return undefined;
    let evidence = contractEvidence.get(reference);
    if (evidence === undefined) {
      evidence = { total: 0, punctual: 0, cancelled: 0, trainKm: 0n, missingSeats: 0, missedConnections: 0, costCents: 0n, contractPenaltyCents: 0n };
      contractEvidence.set(reference, evidence);
    }
    return evidence;
  };
  const decisionsByAction: Record<string, number> = {};
  const infrastructureEffects: string[] = [];
  const personnelEffects: string[] = [];
  const vehicleEffects: string[] = [];
  const decisionFacts: DailyDecisionFact[] = [];
  for (const event of selected) {
    const value = payload(event.payload)!;
    const impact = payload(value.impact) ?? {};
    if (event.eventType === "operations.train-outcome") {
      const contract = evidenceFor(value);
      total += 1;
      trainKm = addBigInt(trainKm, value.trainKm ?? value.train_km);
      const outcomeMissingSeats = Number(value.missingSeats ?? value.missing_seats ?? 0);
      const outcomeMissedConnections = Number(value.missedConnections ?? value.missed_connections ?? 0);
      if (Number.isSafeInteger(outcomeMissingSeats) && outcomeMissingSeats >= 0) missingSeats += outcomeMissingSeats;
      if (Number.isSafeInteger(outcomeMissedConnections) && outcomeMissedConnections >= 0) missedConnections += outcomeMissedConnections;
      const status = text(value.status);
      if (contract !== undefined) {
        contract.total += 1;
        contract.trainKm = addBigInt(contract.trainKm, value.trainKm ?? value.train_km);
        if (Number.isSafeInteger(outcomeMissingSeats) && outcomeMissingSeats >= 0) contract.missingSeats += outcomeMissingSeats;
        if (Number.isSafeInteger(outcomeMissedConnections) && outcomeMissedConnections >= 0) contract.missedConnections += outcomeMissedConnections;
        if (status === "cancelled") contract.cancelled += 1;
        else if (Number(value.delaySeconds ?? value.delay_seconds ?? 0) <= 300) contract.punctual += 1;
      }
      if (status === "cancelled") cancelled += 1;
      else if (Number(value.delaySeconds ?? value.delay_seconds ?? 0) <= 300) punctual += 1;
      else delayed += 1;
    }
    if (DECISION_EVENT_TYPES.has(event.eventType)) {
      const contract = evidenceFor(value);
      const action = text(value.action ?? value.selected_action ?? value.decision) || "unbekannt";
      const explanation = payload(value.explanation) ?? value;
      decisionsByAction[action] = (decisionsByAction[action] ?? 0) + 1;
      if (action === "trigger_rail_replacement") replacementServices += 1;
      infrastructureEffects.push(text(value.affectedResource ?? value.affected_resource ?? impact.affected_resource));
      personnelEffects.push(text(value.personnelEffect ?? value.personnel_effect ?? impact.personnel_effect));
      vehicleEffects.push(text(value.vehicleEffect ?? value.vehicle_effect ?? impact.vehicle_effect));
      costCents = addBigInt(costCents, impact.cost_cents ?? impact.costCents);
      contractPenaltyCents = addBigInt(contractPenaltyCents, impact.contract_penalty_cents ?? impact.contractPenaltyCents);
      if (contract !== undefined) {
        contract.costCents = addBigInt(contract.costCents, impact.cost_cents ?? impact.costCents);
        contract.contractPenaltyCents = addBigInt(contract.contractPenaltyCents, impact.contract_penalty_cents ?? impact.contractPenaltyCents);
      }
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
      const contract = evidenceFor(value);
      revenueCents = addBigInt(revenueCents, value.revenueCents ?? value.revenue_cents);
      costCents = addBigInt(costCents, value.costCents ?? value.cost_cents);
      contractPenaltyCents = addBigInt(contractPenaltyCents, value.contractPenaltyCents ?? value.contract_penalty_cents);
      if (contract !== undefined) {
        contract.costCents = addBigInt(contract.costCents, value.costCents ?? value.cost_cents);
        contract.contractPenaltyCents = addBigInt(contract.contractPenaltyCents, value.contractPenaltyCents ?? value.contract_penalty_cents);
      }
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
    trainRuns: { total, punctual, delayed, cancelled, replacementServices, trainKm: trainKm.toString(), missingSeats, missedConnections },
    settlements: { revenueCents: revenueCents.toString(), costCents: costCents.toString(), contractPenaltyCents: contractPenaltyCents.toString() },
    contracts: Object.fromEntries([...contractEvidence].sort(([left], [right]) => left.localeCompare(right)).map(([reference, evidence]) => [reference, {
      trainRuns: { total: evidence.total, punctual: evidence.punctual, cancelled: evidence.cancelled, trainKm: evidence.trainKm.toString(), missingSeats: evidence.missingSeats, missedConnections: evidence.missedConnections },
      settlements: { costCents: evidence.costCents.toString(), contractPenaltyCents: evidence.contractPenaltyCents.toString() },
    }])),
    decisionsByAction: Object.fromEntries(Object.entries(decisionsByAction).sort(([left], [right]) => left.localeCompare(right))),
    infrastructureEffects: unique(infrastructureEffects),
    personnelEffects: unique(personnelEffects),
    vehicleEffects: unique(vehicleEffects),
    facts: { eventSequences: selected.map((event) => event.sequence), decisions: decisionFacts },
    assessment: { nextLevers },
  };
}
