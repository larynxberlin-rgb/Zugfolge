import { canonicalJson } from "./canonical-json.js";
import type { DemandDataUpdatePayload } from "./contracts.js";
import type { CommerceDatabase } from "./store.js";

export const DEMAND_DATA_UPDATE_MAX_BYTES = 16 * 1024 * 1024;

export interface DemandDataCommandContext {
  readonly payload: DemandDataUpdatePayload;
  readonly commandId: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly receivedAt: Date;
  readonly now: Date;
  /** Die Transaktion hält den Queue-Claim; der Game-Handler nimmt darin seinen WorldMutex. */
  readonly db: CommerceDatabase;
}

export interface DemandDataCommandResult {
  readonly outcome: "accepted" | "rejected";
  readonly code?: string;
  readonly detail?: string;
}

export type DemandDataCommandHandler = (context: DemandDataCommandContext) => Promise<DemandDataCommandResult> | DemandDataCommandResult;

export class DemandDataValidationError extends TypeError {
  constructor(message = "Ungültiger Nachfragedatenvertrag.") {
    super(message);
    this.name = "DemandDataValidationError";
  }
}

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new DemandDataValidationError();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Readonly<Record<string, unknown>>;
}

function keys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  requireValue(Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key)));
}

function text(value: unknown, maximum = 500): void {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= maximum);
}

function unsigned(value: unknown, maximum = 4_294_967_295): void {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum);
}

function rows(value: unknown, maximum: number, minimum = 0): readonly unknown[] {
  requireValue(Array.isArray(value) && value.length >= minimum && value.length <= maximum);
  return value;
}

/** Transportgrenzen vor HMAC-Kanonisierung; die fachliche Bindung prüft der Rust-Kern. */
export function validateDemandDataUpdate(value: unknown): asserts value is DemandDataUpdatePayload {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  let stringBytes = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    requireValue(++visited <= 600_000 && item.depth <= 16);
    if (typeof item.value === "string") {
      stringBytes += Buffer.byteLength(item.value, "utf8");
      requireValue(stringBytes <= DEMAND_DATA_UPDATE_MAX_BYTES);
    } else if (typeof item.value === "number") {
      requireValue(Number.isSafeInteger(item.value));
    } else if (item.value !== null && typeof item.value === "object") {
      const nestedValues = Object.values(item.value);
      requireValue(nestedValues.length <= 40_000);
      for (const nested of nestedValues) pending.push({ value: nested, depth: item.depth + 1 });
    } else {
      requireValue(item.value === null || typeof item.value === "boolean");
    }
  }
  requireValue(Buffer.byteLength(canonicalJson(value), "utf8") <= DEMAND_DATA_UPDATE_MAX_BYTES);
  const payload = record(value);
  keys(payload, ["kind", "schemaVersion", "worldId", "sourceRevision", "baseReleaseId", "populationModel", "zonePopulations"]);
  requireValue(payload["kind"] === "demand.data.update" && payload["schemaVersion"] === "zugfolge-demand-data-update/v1");
  requireValue(typeof payload["worldId"] === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(payload["worldId"]));
  text(payload["baseReleaseId"]);
  unsigned(payload["sourceRevision"], Number.MAX_SAFE_INTEGER);
  requireValue((payload["sourceRevision"] as number) >= 1);
  const seenZones = new Set<string>();
  for (const value of rows(payload["zonePopulations"], 200, 2)) {
    const zone = record(value);
    keys(zone, ["zoneId", "population"]);
    text(zone["zoneId"]);
    unsigned(zone["population"]);
    requireValue(!seenZones.has(zone["zoneId"] as string));
    seenZones.add(zone["zoneId"] as string);
  }
  const model = record(payload["populationModel"]);
  keys(model, ["schemaVersion", "settlements", "stationAreas", "referenceTimetable", "destinationPreferences"]);
  requireValue(model["schemaVersion"] === "zugfolge-station-population-demand/v1");
  for (const value of rows(model["settlements"], 20_000, 1)) {
    const settlement = record(value);
    keys(settlement, ["id", "name", "population", "sourceId"]);
    for (const key of ["id", "name", "sourceId"]) text(settlement[key]);
    unsigned(settlement["population"]);
  }
  let allocationCount = 0;
  for (const value of rows(model["stationAreas"], 200, 2)) {
    const area = record(value);
    keys(area, ["zoneId", "stationId", "populationAllocations", "demandClass"]);
    text(area["zoneId"]); text(area["stationId"]); unsigned(area["demandClass"], 10);
    for (const value of rows(area["populationAllocations"], 40_000)) {
      requireValue(++allocationCount <= 40_000);
      const allocation = record(value);
      keys(allocation, ["settlementId", "population"]);
      text(allocation["settlementId"]); unsigned(allocation["population"]);
    }
  }
  const reference = record(model["referenceTimetable"]);
  keys(reference, ["id", "artifactSha256", "sourceIds", "serviceDates"]);
  text(reference["id"]);
  requireValue(typeof reference["artifactSha256"] === "string" && /^[a-f0-9]{64}$/.test(reference["artifactSha256"]));
  for (const source of rows(reference["sourceIds"], 128, 1)) text(source);
  for (const day of rows(reference["serviceDates"], 7, 7)) requireValue(typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day));
  for (const value of rows(model["destinationPreferences"], 200 * 199)) {
    const preference = record(value);
    keys(preference, ["originZoneId", "destinationZoneId", "referenceConnections"]);
    text(preference["originZoneId"]); text(preference["destinationZoneId"]); unsigned(preference["referenceConnections"]);
  }
}

export function validateDemandDataResult(result: DemandDataCommandResult): void {
  requireValue(result.outcome === "accepted" || result.outcome === "rejected");
  if (result.code !== undefined) requireValue(/^[a-zA-Z0-9_.:-]{1,100}$/.test(result.code));
  if (result.detail !== undefined) requireValue(typeof result.detail === "string" && result.detail.length <= 1000);
}
