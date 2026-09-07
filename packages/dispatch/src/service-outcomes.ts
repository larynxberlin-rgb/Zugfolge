import { nativeServiceDayEvidence } from "./service-days.js";

/** Unverfaelschte Vollstaendigkeit der nativen Tagesfahrtbelege. */
export interface ServiceOutcomeEvidence {
  readonly evidenceComplete: boolean;
  readonly plannedServiceRunIds: readonly string[];
  readonly missingServiceRunIds: readonly string[];
  readonly distanceMm: string;
  readonly minimumSeatsProvided: number | null;
  readonly missingSeats: number | null;
  readonly missedConnections: number | null;
  readonly dayPlanComplete?: boolean;
  readonly vehicleCostEvidenceComplete?: boolean;
  readonly formationOperatingCostCents?: string | null;
}

export function nativeServiceEvidence(records: readonly Readonly<Record<string, unknown>>[]): ServiceOutcomeEvidence | undefined {
  const native = records.filter((value) => value["schemaVersion"] === "zugfolge-operational-train-service-planned/v1"
    || value["schemaVersion"] === "zugfolge-operational-train-outcome/v1");
  if (native.length === 0 && !records.some((record) => record.schemaVersion === "zugfolge-operational-service-day-planned/v1")) return undefined;
  const planned = new Map<string, Readonly<Record<string, unknown>>>();
  const outcomes = new Map<string, Readonly<Record<string, unknown>>>();
  let valid = true;
  let identityValid = true;
  const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  for (const value of native) {
    const id = value["serviceRunId"];
    if (typeof id !== "string" || id.length === 0) { valid = false; identityValid = false; continue; }
    const destination = value["schemaVersion"] === "zugfolge-operational-train-service-planned/v1" ? planned : outcomes;
    const previous = destination.get(id);
    // A transfer can repeat the identical plan; an outcome must occur exactly once.
    if (previous !== undefined && (destination === outcomes || ["worldId", "operatorId", "lotId", "trainRunId", "serviceDay", "scheduledArrivalMs", "requiredSeats", "connectionAssessment"].some((key) => previous[key] !== value[key]))) { valid = false; identityValid = false; }
    else destination.set(id, value);
  }
  let distanceMm = 0n;
  let minimumSeatsProvided: number | null = null;
  let capacitiesComplete = true;
  let missingSeats: number | null = 0;
  let missedConnections: number | null = 0;
  for (const [id, value] of outcomes) {
    const plan = planned.get(id);
    if (plan === undefined || ["worldId", "operatorId", "lotId", "trainRunId", "serviceDay", "scheduledArrivalMs"].some((key) => plan[key] !== value[key])) { valid = false; identityValid = false; }
    if (typeof value["distanceMm"] === "string" && /^\d+$/u.test(value["distanceMm"])) distanceMm += BigInt(value["distanceMm"]);
    else { valid = false; identityValid = false; }
    if (integer(value["minimumSeatsProvided"])) minimumSeatsProvided = Math.min(minimumSeatsProvided ?? value["minimumSeatsProvided"], value["minimumSeatsProvided"]);
    else { valid = false; capacitiesComplete = false; }
    if (integer(value["missingSeats"]) && missingSeats !== null) missingSeats += value["missingSeats"];
    else missingSeats = null;
    if (integer(value["missedConnections"]) && missedConnections !== null) missedConnections += value["missedConnections"];
    else missedConnections = null;
    if (value["evidenceComplete"] !== true) valid = false;
  }
  const day = nativeServiceDayEvidence(records, planned, outcomes);
  const allPlanned = new Set([...planned.keys(), ...(day?.expectedServiceRunIds ?? [])]);
  const missingServiceRunIds = [...allPlanned].filter((id) => !outcomes.has(id)).sort();
  if (missingServiceRunIds.length > 0 || outcomes.size === 0) {
    missingSeats = null;
    missedConnections = null;
  }
  return {
    evidenceComplete: valid && planned.size > 0 && missingServiceRunIds.length === 0,
    plannedServiceRunIds: [...allPlanned].sort(), missingServiceRunIds,
    ...(day === undefined ? {} : { dayPlanComplete: identityValid && day.dayPlanComplete, vehicleCostEvidenceComplete: identityValid && day.vehicleCostEvidenceComplete,
      formationOperatingCostCents: day.formationOperatingCostCents }),
    distanceMm: distanceMm.toString(), minimumSeatsProvided: capacitiesComplete && missingServiceRunIds.length === 0 ? minimumSeatsProvided : null, missingSeats, missedConnections,
  };
}
