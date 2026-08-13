/**
 * Versionierter Fachvertrag fuer einen vorzeitigen Vertragsabbruch wegen
 * Nichterfuellung. Nur unveraenderliche Betriebsereignisse koennen die Regel
 * erfuellen; Text und Browserzustand sind ausdruecklich keine Beweise.
 */
export const CONTRACT_NON_PERFORMANCE_RULE = Object.freeze({
  schemaVersion: "zugfolge-contract-non-performance-rule/v1" as const,
  evidenceReferenceSchema: "daily-operation-report/v1" as const,
  qualifyingEvents: Object.freeze([
    "operations.train-outcome",
    "economy.settlement",
  ] as const),
});

export interface ContractNonPerformanceEvent {
  readonly eventType: string;
  readonly payload: unknown;
}

export interface ContractNonPerformanceBinding {
  readonly contractId: string;
  readonly accusedOperatorId: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function positiveIntegerText(value: unknown): boolean {
  return (typeof value === "string" && /^[1-9][0-9]*$/.test(value))
    || positiveInteger(value);
}

/** Reine, deterministische Auswertung der versionierten Nichterfuellungsregel. */
export function provesContractNonPerformanceV1(
  event: ContractNonPerformanceEvent,
  binding: ContractNonPerformanceBinding,
): boolean {
  const payload = record(event.payload);
  if (payload === undefined
    || (payload["contractId"] ?? payload["contract_id"]) !== binding.contractId
    || (payload["operatorId"] ?? payload["operator_id"]) !== binding.accusedOperatorId) return false;

  if (event.eventType === "operations.train-outcome") {
    return payload["status"] === "cancelled"
      || positiveInteger(payload["missingSeats"] ?? payload["missing_seats"])
      || positiveInteger(payload["missedConnections"] ?? payload["missed_connections"]);
  }
  if (event.eventType === "economy.settlement") {
    return positiveIntegerText(payload["contractPenaltyCents"] ?? payload["contract_penalty_cents"]);
  }
  return false;
}

export function dailyOperationEvidenceReference(serviceDay: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDay)) throw new RangeError("Betriebstag muss YYYY-MM-DD entsprechen.");
  return `${CONTRACT_NON_PERFORMANCE_RULE.evidenceReferenceSchema}:${serviceDay}`;
}

export function parseDailyOperationEvidenceReference(reference: string): string | undefined {
  const prefix = `${CONTRACT_NON_PERFORMANCE_RULE.evidenceReferenceSchema}:`;
  const serviceDay = reference.startsWith(prefix) ? reference.slice(prefix.length) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDay)) return undefined;
  const parsed = new Date(`${serviceDay}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== serviceDay
    ? undefined
    : serviceDay;
}
