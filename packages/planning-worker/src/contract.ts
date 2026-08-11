import {
  PLANNING_APPLY_ALTERNATIVE_SCHEMA,
  type PlanningApplyAlternativePayload,
  type PlanningCoordinateRequest,
  type PlanningCoordinateSegment,
  type PlanningCoordinateStation,
} from "@zugfolge/planning-runtime-native";

export const PLANNING_PATH_REQUEST_SCHEMA = "planning.path-request/v1" as const;
export const PLANNING_COORDINATE_AUTHORITY_SCHEMA = "planning.coordinate/v1" as const;
export const PLANNING_INFRASTRUCTURE_RELEASE_SCHEMA = "planning.infrastructure-release/v1" as const;

export interface PlanningPathRequestBody extends Omit<PlanningCoordinateRequest, "requestNumericId"> {
  readonly schemaVersion: typeof PLANNING_PATH_REQUEST_SCHEMA;
  readonly requestId: string;
}

/** Persisted form. World and account are always bound by the authenticated route. */
export interface BoundPlanningPathRequest extends PlanningPathRequestBody {
  readonly worldId: string;
  readonly requestingAccountId: string;
}

/**
 * Internal coordination command. It contains references only: neither a player
 * nor the authority command can submit infrastructure or another account's
 * request facts through this payload.
 */
export interface PlanningCoordinateAuthorityCommand {
  readonly schemaVersion: typeof PLANNING_COORDINATE_AUTHORITY_SCHEMA;
  readonly worldId: string;
  readonly runId: string;
  readonly expectedProjectionRevision: number | null;
  readonly seedWorld: string;
  readonly seedPeriod: number;
  readonly infrastructureReleaseId: string;
  readonly requestCommandIds: readonly [string, string];
}

export type PlanningCoordinateAuthorityBody = Omit<PlanningCoordinateAuthorityCommand, "worldId">;

/** Immutable, server-owned facts resolved by release ID inside the worker. */
export interface PlanningInfrastructureRelease {
  readonly schemaVersion: typeof PLANNING_INFRASTRUCTURE_RELEASE_SCHEMA;
  readonly worldId: string;
  readonly releaseId: string;
  readonly sourceId: string;
  readonly corridorId: string;
  readonly corridorName: string;
  readonly stations: readonly PlanningCoordinateStation[];
  readonly segments: readonly PlanningCoordinateSegment[];
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

function exactRecord(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value), `${name} ist kein Objekt.`);
  const result = value as Record<string, unknown>;
  invariant(
    Object.keys(result).length === keys.length && Object.keys(result).every((key) => keys.includes(key)),
    `${name} besitzt nicht exakt die Felder ${keys.join(", ")}.`,
  );
  return result;
}

function text(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string" && value.trim().length > 0, `${name} ist keine nichtleere Zeichenkette.`);
}

function integer(value: unknown, name: string, minimum = 0): asserts value is number {
  invariant(Number.isSafeInteger(value) && (value as number) >= minimum, `${name} ist keine sichere Ganzzahl ab ${minimum}.`);
}

const REQUEST_KEYS = [
  "requestId",
  "trainId",
  "trainCategory",
  "trainNumber",
  "originStationId",
  "destinationStationId",
  "desiredDepartureS",
  "operatingDays",
  "stops",
  "earlierS",
  "laterS",
  "stepS",
  "extraRunningTimeS",
  "maxOperationalStops",
  "train",
] as const;

function validateRequestFacts(input: Record<string, unknown>, name: string): void {
  for (const key of ["requestId", "trainId", "originStationId", "destinationStationId"] as const) {
    text(input[key], `${name}.${key}`);
  }
  invariant(
    ["long-distance", "suburban", "regional", "freight", "supplementary"].includes(input["trainCategory"] as string),
    `${name}.trainCategory ist unbekannt.`,
  );
  invariant(["daily", "workdays", "weekend"].includes(input["operatingDays"] as string), `${name}.operatingDays ist unbekannt.`);
  integer(input["trainNumber"], `${name}.trainNumber`, 1);
  integer(input["desiredDepartureS"], `${name}.desiredDepartureS`);
  integer(input["earlierS"], `${name}.earlierS`);
  integer(input["laterS"], `${name}.laterS`);
  integer(input["stepS"], `${name}.stepS`, 1);
  integer(input["extraRunningTimeS"], `${name}.extraRunningTimeS`);
  integer(input["maxOperationalStops"], `${name}.maxOperationalStops`);
  invariant(Array.isArray(input["stops"]), `${name}.stops ist keine Liste.`);
  for (const [index, value] of input["stops"].entries()) {
    const stop = exactRecord(value, `${name}.stops[${index}]`, ["stationId", "minimumDwellS"]);
    text(stop["stationId"], `${name}.stops[${index}].stationId`);
    integer(stop["minimumDwellS"], `${name}.stops[${index}].minimumDwellS`);
  }
  const train = exactRecord(input["train"], `${name}.train`, [
    "numericId",
    "name",
    "massKg",
    "lengthMm",
    "maximumSpeedKph",
    "accelerationMmPerS2",
    "decelerationMmPerS2",
  ]);
  text(train["name"], `${name}.train.name`);
  integer(train["numericId"], `${name}.train.numericId`);
  for (const key of ["massKg", "lengthMm", "maximumSpeedKph", "accelerationMmPerS2", "decelerationMmPerS2"] as const) {
    integer(train[key], `${name}.train.${key}`, 1);
  }
}

/** Binds one player's path request to the authenticated world and account. */
export function bindPlanningPathRequest(
  worldId: string,
  requestingAccountId: string,
  value: unknown,
): BoundPlanningPathRequest {
  text(worldId, "worldId");
  text(requestingAccountId, "requestingAccountId");
  const input = exactRecord(value, "planning.path-request", ["schemaVersion", ...REQUEST_KEYS]);
  invariant(input["schemaVersion"] === PLANNING_PATH_REQUEST_SCHEMA, "planning.path-request hat ein unbekanntes Schema.");
  validateRequestFacts(input, "planning.path-request");
  return { worldId, requestingAccountId, ...input } as unknown as BoundPlanningPathRequest;
}

/**
 * Binds an authority-only coordination request. This function intentionally
 * has no player route alias and accepts no infrastructure facts.
 */
export function bindPlanningCoordinateAuthorityCommand(
  worldId: string,
  value: unknown,
): PlanningCoordinateAuthorityCommand {
  text(worldId, "worldId");
  const input = exactRecord(value, "planning.coordinate", [
    "schemaVersion",
    "runId",
    "expectedProjectionRevision",
    "seedWorld",
    "seedPeriod",
    "infrastructureReleaseId",
    "requestCommandIds",
  ]);
  invariant(input["schemaVersion"] === PLANNING_COORDINATE_AUTHORITY_SCHEMA, "planning.coordinate hat ein unbekanntes Schema.");
  for (const key of ["runId", "seedWorld", "infrastructureReleaseId"] as const) text(input[key], `planning.coordinate.${key}`);
  invariant(/^[0-9]+$/.test(input["seedWorld"] as string), "planning.coordinate.seedWorld ist keine u64-Dezimalzahl.");
  integer(input["seedPeriod"], "planning.coordinate.seedPeriod");
  if (input["expectedProjectionRevision"] !== null) {
    integer(input["expectedProjectionRevision"], "planning.coordinate.expectedProjectionRevision");
  }
  invariant(
    Array.isArray(input["requestCommandIds"])
      && input["requestCommandIds"].length === 2
      && input["requestCommandIds"].every((item) => typeof item === "string" && item.length > 0)
      && input["requestCommandIds"][0] !== input["requestCommandIds"][1],
    "planning.coordinate muss exakt zwei verschiedene Antragskommando-IDs referenzieren.",
  );
  return { worldId, ...input } as unknown as PlanningCoordinateAuthorityCommand;
}

function validateStation(value: unknown, index: number): void {
  const station = exactRecord(value, `planning.infrastructure-release.stations[${index}]`, [
    "numericId", "id", "code", "name", "distanceMm", "latitudeE7", "longitudeE7",
    "stationTrackNumericId", "stationTrackLengthMm", "stationMaximumSpeedKph",
  ]);
  for (const key of ["id", "code", "name"] as const) text(station[key], `planning.infrastructure-release.stations[${index}].${key}`);
  for (const key of ["numericId", "distanceMm", "stationTrackNumericId"] as const) integer(station[key], `planning.infrastructure-release.stations[${index}].${key}`);
  integer(station["latitudeE7"], `planning.infrastructure-release.stations[${index}].latitudeE7`, Number.MIN_SAFE_INTEGER);
  integer(station["longitudeE7"], `planning.infrastructure-release.stations[${index}].longitudeE7`, Number.MIN_SAFE_INTEGER);
  integer(station["stationTrackLengthMm"], `planning.infrastructure-release.stations[${index}].stationTrackLengthMm`, 1);
  integer(station["stationMaximumSpeedKph"], `planning.infrastructure-release.stations[${index}].stationMaximumSpeedKph`, 1);
}

function validateSegment(value: unknown, index: number): void {
  const segment = exactRecord(value, `planning.infrastructure-release.segments[${index}]`, [
    "edgeNumericId", "trackNumericId", "id", "label", "fromStationId", "toStationId", "lengthMm",
    "maximumSpeedKph", "mainSignalPositionsMm", "maximumVirtualBlockLengthMm",
  ]);
  for (const key of ["id", "label", "fromStationId", "toStationId"] as const) text(segment[key], `planning.infrastructure-release.segments[${index}].${key}`);
  for (const key of ["edgeNumericId", "trackNumericId"] as const) integer(segment[key], `planning.infrastructure-release.segments[${index}].${key}`);
  for (const key of ["lengthMm", "maximumSpeedKph", "maximumVirtualBlockLengthMm"] as const) integer(segment[key], `planning.infrastructure-release.segments[${index}].${key}`, 1);
  invariant(Array.isArray(segment["mainSignalPositionsMm"]), `planning.infrastructure-release.segments[${index}].mainSignalPositionsMm ist keine Liste.`);
  for (const [signalIndex, position] of segment["mainSignalPositionsMm"].entries()) {
    integer(position, `planning.infrastructure-release.segments[${index}].mainSignalPositionsMm[${signalIndex}]`);
  }
}

/** Fail-closed validator for trusted, immutable server release configuration. */
export function parsePlanningInfrastructureRelease(
  value: unknown,
  expectedWorldId?: string,
  expectedReleaseId?: string,
): PlanningInfrastructureRelease {
  const input = exactRecord(value, "planning.infrastructure-release", [
    "schemaVersion", "worldId", "releaseId", "sourceId", "corridorId", "corridorName", "stations", "segments",
  ]);
  invariant(input["schemaVersion"] === PLANNING_INFRASTRUCTURE_RELEASE_SCHEMA, "Planning-Infrastrukturrelease hat ein unbekanntes Schema.");
  for (const key of ["worldId", "releaseId", "sourceId", "corridorId", "corridorName"] as const) text(input[key], `planning.infrastructure-release.${key}`);
  if (expectedWorldId !== undefined) invariant(input["worldId"] === expectedWorldId, "Planning-Infrastrukturrelease verletzt die Weltisolation.");
  if (expectedReleaseId !== undefined) invariant(input["releaseId"] === expectedReleaseId, "Planning-Infrastrukturrelease besitzt eine fremde ID.");
  invariant(Array.isArray(input["stations"]) && input["stations"].length >= 2, "Planning-Infrastrukturrelease braucht mindestens zwei Betriebsstellen.");
  invariant(Array.isArray(input["segments"]) && input["segments"].length >= 1, "Planning-Infrastrukturrelease braucht mindestens ein Segment.");
  input["stations"].forEach(validateStation);
  input["segments"].forEach(validateSegment);
  return input as unknown as PlanningInfrastructureRelease;
}

/** Strictly parses the internal payload derived by game-api from one offered alternative. */
export function parsePlanningApplyAlternativePayload(value: unknown): PlanningApplyAlternativePayload {
  const input = exactRecord(value, "planning.apply-alternative", [
    "schemaVersion", "projectionRevision", "alternativeId", "conflictId", "trainId", "departureShiftS",
  ]);
  invariant(input["schemaVersion"] === PLANNING_APPLY_ALTERNATIVE_SCHEMA, "planning.apply-alternative hat ein unbekanntes Schema.");
  integer(input["projectionRevision"], "planning.apply-alternative.projectionRevision");
  for (const key of ["alternativeId", "conflictId", "trainId"] as const) text(input[key], `planning.apply-alternative.${key}`);
  integer(input["departureShiftS"], "planning.apply-alternative.departureShiftS", Number.MIN_SAFE_INTEGER);
  invariant(input["departureShiftS"] !== 0, "planning.apply-alternative.departureShiftS darf nicht null sein.");
  return input as unknown as PlanningApplyAlternativePayload;
}

const positiveInteger = { type: "integer", minimum: 1 } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const nonEmptyString = { type: "string", minLength: 1 } as const;
const pathRequestProperties = {
  schemaVersion: { type: "string", const: PLANNING_PATH_REQUEST_SCHEMA },
  requestId: nonEmptyString,
  trainId: nonEmptyString,
  trainCategory: { enum: ["long-distance", "suburban", "regional", "freight", "supplementary"] },
  trainNumber: positiveInteger,
  originStationId: nonEmptyString,
  destinationStationId: nonEmptyString,
  desiredDepartureS: nonNegativeInteger,
  operatingDays: { enum: ["daily", "workdays", "weekend"] },
  stops: {
    type: "array",
    items: {
      type: "object", additionalProperties: false, required: ["stationId", "minimumDwellS"],
      properties: { stationId: nonEmptyString, minimumDwellS: nonNegativeInteger },
    },
  },
  earlierS: nonNegativeInteger,
  laterS: nonNegativeInteger,
  stepS: positiveInteger,
  extraRunningTimeS: nonNegativeInteger,
  maxOperationalStops: nonNegativeInteger,
  train: {
    type: "object", additionalProperties: false,
    required: ["numericId", "name", "massKg", "lengthMm", "maximumSpeedKph", "accelerationMmPerS2", "decelerationMmPerS2"],
    properties: {
      numericId: nonNegativeInteger, name: nonEmptyString, massKg: positiveInteger, lengthMm: positiveInteger,
      maximumSpeedKph: positiveInteger, accelerationMmPerS2: positiveInteger, decelerationMmPerS2: positiveInteger,
    },
  },
} as const;

/** Fastify-compatible exact body for one authenticated player's request. */
export const PLANNING_PATH_REQUEST_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", ...REQUEST_KEYS],
  properties: pathRequestProperties,
} as const;

/** Authority-only schema; do not expose this as an authenticated player route. */
export const PLANNING_COORDINATE_AUTHORITY_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "runId", "expectedProjectionRevision", "seedWorld", "seedPeriod",
    "infrastructureReleaseId", "requestCommandIds",
  ],
  properties: {
    schemaVersion: { type: "string", const: PLANNING_COORDINATE_AUTHORITY_SCHEMA },
    runId: nonEmptyString,
    // `null` zuerst: Fastify/Ajv darf den initialen Lauf nicht per
    // Zahlen-Koerzierung still in Revision 0 umdeuten.
    expectedProjectionRevision: { anyOf: [{ type: "null" }, nonNegativeInteger] },
    seedWorld: { type: "string", pattern: "^[0-9]+$" },
    seedPeriod: nonNegativeInteger,
    infrastructureReleaseId: nonEmptyString,
    requestCommandIds: { type: "array", minItems: 2, maxItems: 2, uniqueItems: true, items: nonEmptyString },
  },
} as const;
