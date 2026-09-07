type RecordValue = Readonly<Record<string, unknown>>;

/** Zusätzlicher Vollständigkeitsbeleg; Kostenbasis ist ausdrücklich keine zweite Buchung. */
export interface ServiceDayEvidence {
  readonly dayPlanComplete: boolean;
  readonly expectedServiceRunIds: readonly string[];
  readonly vehicleCostEvidenceComplete: boolean;
  readonly formationOperatingCostCents: string | null;
}

const plannedSchema = "zugfolge-operational-service-day-planned/v1";
const closedSchema = "zugfolge-operational-service-day-closed/v1";

export function nativeServiceDayEvidence(records: readonly RecordValue[], originalPlans: ReadonlyMap<string, RecordValue>, outcomes: ReadonlyMap<string, RecordValue>): ServiceDayEvidence | undefined {
  const native = records.filter((value) => value.schemaVersion === plannedSchema || value.schemaVersion === closedSchema);
  if (native.length === 0) return undefined;
  const plans = new Map<string, RecordValue>();
  const closes = new Map<string, RecordValue>();
  const expected = new Set<string>();
  let valid = true;
  let costsComplete = true;
  let cents = 0n;
  const costRecords = new Map<string, RecordValue>();
  for (const cost of records.filter((record) => record.schemaVersion === "zugfolge-operational-service-vehicle-cost/v1")) {
    if (typeof cost.serviceRunId !== "string" || costRecords.has(cost.serviceRunId)) valid = false;
    else costRecords.set(cost.serviceRunId, cost);
  }
  const ids = (value: unknown): readonly string[] | undefined => Array.isArray(value) && value.length > 0
    && value.every((id) => typeof id === "string" && id.length > 0) && new Set(value).size === value.length ? value as string[] : undefined;
  for (const value of native) {
    if (typeof value.serviceDayId !== "string" || ids(value.serviceRunIds) === undefined) { valid = false; continue; }
    const destination = value.schemaVersion === plannedSchema ? plans : closes;
    if (destination.has(value.serviceDayId)) valid = false;
    else destination.set(value.serviceDayId, value);
  }
  for (const [id, plan] of plans) {
    const expectedIds = ids(plan.serviceRunIds)!;
    for (const runId of expectedIds) {
      if (expected.has(runId)) valid = false;
      expected.add(runId);
    }
    const close = closes.get(id);
    if (close === undefined || ["worldId", "regionId", "operatorId", "lotId", "serviceDay", "dayIndex", "dayEndMs"].some((key) => plan[key] !== close[key])
      || JSON.stringify(expectedIds) !== JSON.stringify(close.serviceRunIds) || close.dayPlanComplete !== true
      || typeof close.closedAtMs !== "number" || typeof close.dayEndMs !== "number" || close.closedAtMs < close.dayEndMs
      || expectedIds.some((runId) => {
        const original = originalPlans.get(runId);
        const outcome = outcomes.get(runId);
        return original === undefined || outcome === undefined || ["worldId", "regionId", "operatorId", "lotId", "serviceDay"].some((key) => original[key] !== plan[key] || outcome[key] !== plan[key]);
      })) { valid = false; costsComplete = false; continue; }
    let numerator = 0n;
    let groupCostsComplete = true;
    for (const runId of expectedIds) {
      const cost = costRecords.get(runId);
      const outcome = outcomes.get(runId)!;
      if (cost === undefined || cost.evidenceComplete !== true || cost.basis !== "formation-operating-cost"
        || ["worldId", "regionId", "operatorId", "lotId", "serviceDay", "trainRunId"].some((key) => cost[key] !== outcome[key])
        || typeof cost.millimetreCents !== "string" || !/^(?:0|[1-9]\d*)$/u.test(cost.millimetreCents)) groupCostsComplete = false;
      else numerator += BigInt(cost.millimetreCents);
    }
    if (close.vehicleCostEvidenceComplete === true && typeof close.formationOperatingCostCents === "string"
      && /^(?:0|[1-9]\d*)$/u.test(close.formationOperatingCostCents) && groupCostsComplete
      && numerator / 1_000_000n === BigInt(close.formationOperatingCostCents)) cents += BigInt(close.formationOperatingCostCents);
    else costsComplete = false;
  }
  if (plans.size === 0 || plans.size !== closes.size || outcomes.size !== expected.size || originalPlans.size !== expected.size
    || [...outcomes.keys(), ...originalPlans.keys()].some((id) => !expected.has(id))) valid = false;
  if (costRecords.size !== expected.size || [...costRecords.keys()].some((id) => !expected.has(id))) costsComplete = false;
  return { dayPlanComplete: valid, expectedServiceRunIds: [...expected].sort(), vehicleCostEvidenceComplete: valid && costsComplete,
    formationOperatingCostCents: valid && costsComplete ? cents.toString() : null };
}
