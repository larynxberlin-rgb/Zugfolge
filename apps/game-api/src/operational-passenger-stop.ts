/** Transportprüfung ausschließlich nativer, im Regionalcommit bestätigter Haltbelege. */
export interface OperationalPassengerStopReceipt {
  readonly schemaVersion: "zugfolge-operational-passenger-stop-receipt/v1";
  readonly worldId: string;
  readonly serviceRunId: string;
  readonly trainRunId: string;
  readonly stopId: string;
  readonly stopSequence: number;
  readonly stopPlanHash: string;
  readonly routeVersionId: string;
  readonly formationVersionId: string;
  readonly kind: "arrival" | "departure";
  readonly actualTimeMs: number;
  readonly receiptId: string;
}

const FIELDS = ["schemaVersion", "worldId", "serviceRunId", "trainRunId", "stopId", "stopSequence",
  "stopPlanHash", "routeVersionId", "formationVersionId", "kind", "actualTimeMs", "receiptId"];

export function decodeOperationalPassengerStop(
  kind: "passenger-stop-arrival" | "passenger-stop-departure", detail: string,
  trainId: string, atMs: number, worldId?: string,
): OperationalPassengerStopReceipt {
  if (Buffer.byteLength(detail) > 16_384) throw new TypeError("Nativer Haltbeleg überschreitet die Transportgrenze.");
  const value: unknown = JSON.parse(detail);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Nativer Haltbeleg ist kein Objekt.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== FIELDS.length || Object.keys(row).some((key) => !FIELDS.includes(key))
    || row["schemaVersion"] !== "zugfolge-operational-passenger-stop-receipt/v1"
    || row["trainRunId"] !== trainId || (worldId !== undefined && row["worldId"] !== worldId)
    || row["kind"] !== (kind === "passenger-stop-arrival" ? "arrival" : "departure")
    || row["actualTimeMs"] !== atMs || !Number.isSafeInteger(atMs) || atMs < 0
    || !Number.isSafeInteger(row["stopSequence"]) || Number(row["stopSequence"]) < 0 || Number(row["stopSequence"]) >= 100
    || typeof row["stopPlanHash"] !== "string" || !/^[a-f0-9]{64}$/u.test(row["stopPlanHash"])
    || ["worldId", "serviceRunId", "trainRunId", "stopId", "routeVersionId", "formationVersionId", "receiptId"]
      .some((key) => typeof row[key] !== "string" || row[key].length === 0 || row[key].length > 500)) {
    throw new TypeError("Nativer Haltbeleg verletzt Welt-, Halt- oder Ereignisbindung.");
  }
  return Object.freeze(row as unknown as OperationalPassengerStopReceipt);
}
