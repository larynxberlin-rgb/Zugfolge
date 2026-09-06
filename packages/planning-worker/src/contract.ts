import {
  PLANNING_APPLY_ALTERNATIVE_SCHEMA,
  type PlanningApplyAlternativePayload,
  type PlanningCoordinateBoundaryWindow,
  type PlanningCoordinateRequestV1,
  type PlanningCoordinateRequestV2,
  type PlanningCoordinateSegment,
  type PlanningCoordinateStation,
} from "@zugfolge/planning-runtime-native";

export const PLANNING_PLAYER_PATH_REQUEST_SCHEMA = "planning.player-path-request/v2" as const;
export const PLANNING_PATH_REQUEST_SCHEMA_V3 = "planning.path-request/v3" as const;
export const PLANNING_PATH_REQUEST_SCHEMA = "planning.path-request/v4" as const;
export const PLANNING_COORDINATE_AUTHORITY_SCHEMA = "planning.coordinate/v1" as const;
export const PLANNING_COORDINATE_BATCH_AUTHORITY_SCHEMA = "planning.coordinate/v2" as const;
export const PLANNING_INFRASTRUCTURE_RELEASE_SCHEMA = "planning.infrastructure-release/v1" as const;

export interface PlanningPlayerPathRequestBody extends Omit<PlanningCoordinateRequestV2, "requestNumericId" | "boundaryWindows" | "train" | "trainId" | "trainNumber"> {
  readonly schemaVersion: typeof PLANNING_PLAYER_PATH_REQUEST_SCHEMA;
  readonly requestId: string;
  readonly formationId: string;
  /** Opaque Referenz; die Zeitwerte selbst darf ein Spieler nie einreichen. */
  readonly boundaryPlanningWindowId?: string;
}

/**
 * Internes, serverautoritativ vervollstaendigtes Planungskommando. Die
 * Flottenreferenz bindet die abgeleitete Physik an genau den geprüften
 * Single-Writer-Zustand; kein Feld davon stammt aus dem Spielerrequest.
 */
interface PlanningPathAuthorityFacts {
  readonly requestId: string;
  readonly formationId: string;
  /** Serverseitig aus dem Flotten-/Trassenbeleg abgeleitete EVU-Bindung. */
  readonly operatorId: string;
  readonly fleetRevision: number;
  readonly fleetStateHash: string;
  readonly fleetAuthorityReleaseId: string;
  /** Opaque Referenz; die Zeitwerte selbst darf ein Spieler nie einreichen. */
  readonly boundaryPlanningWindowId?: string;
}

/** Persistierter v3-Altvertrag mit ganzzahliger km/h-Vmax. */
export interface PlanningPathRequestBodyV3
  extends Omit<PlanningCoordinateRequestV1, "requestNumericId" | "boundaryWindows">,
    PlanningPathAuthorityFacts {
  readonly schemaVersion: typeof PLANNING_PATH_REQUEST_SCHEMA_V3;
}

export interface PlanningPathRequestBody
  extends Omit<PlanningCoordinateRequestV2, "requestNumericId" | "boundaryWindows">,
    PlanningPathAuthorityFacts {
  readonly schemaVersion: typeof PLANNING_PATH_REQUEST_SCHEMA;
}

export type AnyPlanningPathRequestBody = PlanningPathRequestBodyV3 | PlanningPathRequestBody;

/** Persisted form. World and account are always bound by the authenticated route. */
export type BoundPlanningPathRequest = AnyPlanningPathRequestBody & Readonly<{
  worldId: string;
  requestingAccountId: string;
}>;

/**
 * Internal coordination command. It contains references only: neither a player
 * nor the authority command can submit infrastructure or another account's
 * request facts through this payload.
 */
export interface PlanningCoordinateAuthorityCommand {
  readonly schemaVersion: typeof PLANNING_COORDINATE_AUTHORITY_SCHEMA | typeof PLANNING_COORDINATE_BATCH_AUTHORITY_SCHEMA;
  readonly worldId: string;
  readonly runId: string;
  readonly expectedProjectionRevision: number | null;
  readonly seedWorld: string;
  readonly seedPeriod: number;
  readonly infrastructureReleaseId: string;
  readonly requestCommandIds: readonly string[];
  readonly replaceTrainIds?: readonly string[];
  readonly effectiveFromS?: number;
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
  readonly boundaryPlanningWindows?: readonly PlanningReleaseBoundaryWindow[];
}

export interface PlanningReleaseBoundaryWindow {
  readonly id: string;
  readonly playableLegId: string;
  readonly originStationId: string;
  readonly destinationStationId: string;
  readonly qualityClass: "A" | "B" | "C";
  readonly orderable: boolean;
  readonly windows: readonly PlanningCoordinateBoundaryWindow[];
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

const PLAYER_REQUEST_KEYS = [
  "requestId",
  "formationId",
  "trainCategory",
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
] as const;

const REQUEST_KEYS = [
  ...PLAYER_REQUEST_KEYS,
  "trainId",
  "trainNumber",
  "operatorId",
  "fleetRevision",
  "fleetStateHash",
  "fleetAuthorityReleaseId",
  "train",
] as const;

function validatePlayerRequestFacts(input: Record<string, unknown>, name: string): void {
  for (const key of ["requestId", "formationId", "originStationId", "destinationStationId"] as const) {
    text(input[key], `${name}.${key}`);
  }
  invariant(
    ["long-distance", "suburban", "regional", "freight", "supplementary"].includes(input["trainCategory"] as string),
    `${name}.trainCategory ist unbekannt.`,
  );
  invariant(["daily", "workdays", "weekend"].includes(input["operatingDays"] as string), `${name}.operatingDays ist unbekannt.`);
  integer(input["desiredDepartureS"], `${name}.desiredDepartureS`);
  if (Object.hasOwn(input, "serviceWindow")) {
    const window = exactRecord(input["serviceWindow"], `${name}.serviceWindow`, ["validFromS", "validUntilS"]);
    integer(window["validFromS"], `${name}.serviceWindow.validFromS`);
    integer(window["validUntilS"], `${name}.serviceWindow.validUntilS`, 1);
    invariant(window["validFromS"] <= input["desiredDepartureS"]
      && input["desiredDepartureS"] < window["validUntilS"], `${name}.serviceWindow enthaelt die Abfahrt nicht.`);
  }
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
}

function validateRequestFacts(
  input: Record<string, unknown>,
  name: string,
  schemaVersion: typeof PLANNING_PATH_REQUEST_SCHEMA_V3 | typeof PLANNING_PATH_REQUEST_SCHEMA,
): void {
  validatePlayerRequestFacts(input, name);
  text(input["trainId"], `${name}.trainId`);
  integer(input["trainNumber"], `${name}.trainNumber`, 1);
  text(input["operatorId"], `${name}.operatorId`);
  integer(input["fleetRevision"], `${name}.fleetRevision`);
  text(input["fleetStateHash"], `${name}.fleetStateHash`);
  invariant(/^[a-f0-9]{64}$/.test(input["fleetStateHash"] as string), `${name}.fleetStateHash ist kein SHA-256.`);
  text(input["fleetAuthorityReleaseId"], `${name}.fleetAuthorityReleaseId`);
  const speedField = schemaVersion === PLANNING_PATH_REQUEST_SCHEMA_V3
    ? "maximumSpeedKph"
    : "maximumSpeedMmps";
  const train = exactRecord(input["train"], `${name}.train`, [
    "numericId",
    "name",
    "massKg",
    "lengthMm",
    speedField,
    "accelerationMmPerS2",
    "decelerationMmPerS2",
  ]);
  text(train["name"], `${name}.train.name`);
  integer(train["numericId"], `${name}.train.numericId`);
  for (const key of ["massKg", "lengthMm", speedField, "accelerationMmPerS2", "decelerationMmPerS2"] as const) {
    integer(train[key], `${name}.train.${key}`, 1);
  }
}

/** Validiert den schmalen, nichtautoritativen Spielerrequest fail-closed. */
export function bindPlanningPlayerPathRequest(value: unknown): PlanningPlayerPathRequestBody {
  const withBoundaryReference = typeof value === "object" && value !== null && !Array.isArray(value)
    && "boundaryPlanningWindowId" in value;
  const input = exactRecord(value, "planning.player-path-request", [
    "schemaVersion",
    ...PLAYER_REQUEST_KEYS,
    ...(withBoundaryReference ? ["boundaryPlanningWindowId"] : []),
    ...(typeof value === "object" && value !== null && "serviceWindow" in value ? ["serviceWindow"] : []),
  ]);
  invariant(
    input["schemaVersion"] === PLANNING_PLAYER_PATH_REQUEST_SCHEMA,
    "planning.player-path-request hat ein unbekanntes Schema.",
  );
  validatePlayerRequestFacts(input, "planning.player-path-request");
  if (withBoundaryReference) {
    text(input["boundaryPlanningWindowId"], "planning.player-path-request.boundaryPlanningWindowId");
  }
  return input as unknown as PlanningPlayerPathRequestBody;
}

function bindPlanningPathRequestForRead(
  worldId: string,
  requestingAccountId: string,
  value: unknown,
  allowLegacyV3: boolean,
): BoundPlanningPathRequest {
  text(worldId, "worldId");
  text(requestingAccountId, "requestingAccountId");
  const withBoundaryReference = typeof value === "object" && value !== null && !Array.isArray(value)
    && "boundaryPlanningWindowId" in value;
  const input = exactRecord(value, "planning.path-request", [
    "schemaVersion",
    ...REQUEST_KEYS,
    ...(withBoundaryReference ? ["boundaryPlanningWindowId"] : []),
    ...(typeof value === "object" && value !== null && "serviceWindow" in value ? ["serviceWindow"] : []),
  ]);
  invariant(
    input["schemaVersion"] === PLANNING_PATH_REQUEST_SCHEMA
      || (allowLegacyV3 && input["schemaVersion"] === PLANNING_PATH_REQUEST_SCHEMA_V3),
    "planning.path-request hat ein unbekanntes Schema.",
  );
  validateRequestFacts(
    input,
    "planning.path-request",
    input["schemaVersion"] as typeof PLANNING_PATH_REQUEST_SCHEMA | typeof PLANNING_PATH_REQUEST_SCHEMA_V3,
  );
  if (withBoundaryReference) text(input["boundaryPlanningWindowId"], "planning.path-request.boundaryPlanningWindowId");
  return { worldId, requestingAccountId, ...input } as unknown as BoundPlanningPathRequest;
}

/** Binds a new request; legacy v3 is deliberately not writable anymore. */
export function bindPlanningPathRequest(
  worldId: string,
  requestingAccountId: string,
  value: unknown,
): BoundPlanningPathRequest {
  return bindPlanningPathRequestForRead(worldId, requestingAccountId, value, false);
}

/** Migration adapter for immutable persisted v3/v4 command payloads only. */
export function bindPersistedPlanningPathRequest(
  worldId: string,
  requestingAccountId: string,
  value: unknown,
): BoundPlanningPathRequest {
  return bindPlanningPathRequestForRead(worldId, requestingAccountId, value, true);
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
    ...(typeof value === "object" && value !== null && "replaceTrainIds" in value ? ["replaceTrainIds"] : []),
    ...(typeof value === "object" && value !== null && "effectiveFromS" in value ? ["effectiveFromS"] : []),
  ]);
  invariant(input["schemaVersion"] === PLANNING_COORDINATE_AUTHORITY_SCHEMA
    || input["schemaVersion"] === PLANNING_COORDINATE_BATCH_AUTHORITY_SCHEMA, "planning.coordinate hat ein unbekanntes Schema.");
  if (Object.hasOwn(input, "replaceTrainIds") || Object.hasOwn(input, "effectiveFromS")) {
    invariant(input["schemaVersion"] === PLANNING_COORDINATE_BATCH_AUTHORITY_SCHEMA
      && Array.isArray(input["replaceTrainIds"]) && input["replaceTrainIds"].length >= 1 && input["replaceTrainIds"].length <= 256
      && input["replaceTrainIds"].every((id) => typeof id === "string" && id.length > 0)
      && new Set(input["replaceTrainIds"]).size === input["replaceTrainIds"].length, "Ersetzung braucht v2 und verschiedene Zug-IDs.");
    integer(input["effectiveFromS"], "planning.coordinate.effectiveFromS");
  }
  for (const key of ["runId", "seedWorld", "infrastructureReleaseId"] as const) text(input[key], `planning.coordinate.${key}`);
  invariant(/^[0-9]+$/.test(input["seedWorld"] as string), "planning.coordinate.seedWorld ist keine u64-Dezimalzahl.");
  integer(input["seedPeriod"], "planning.coordinate.seedPeriod");
  if (input["expectedProjectionRevision"] !== null) {
    integer(input["expectedProjectionRevision"], "planning.coordinate.expectedProjectionRevision");
  }
  invariant(
    Array.isArray(input["requestCommandIds"])
      && (input["schemaVersion"] === PLANNING_COORDINATE_AUTHORITY_SCHEMA
        ? input["requestCommandIds"].length === 2
        : input["requestCommandIds"].length >= 1 && input["requestCommandIds"].length <= 256)
      && input["requestCommandIds"].every((item) => typeof item === "string" && item.length > 0)
      && new Set(input["requestCommandIds"]).size === input["requestCommandIds"].length,
    "planning.coordinate braucht verschiedene Antragskommando-IDs: v1 exakt zwei, v2 1 bis 256.",
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
  const withBoundaryWindows = typeof value === "object" && value !== null && !Array.isArray(value)
    && "boundaryPlanningWindows" in value;
  const input = exactRecord(value, "planning.infrastructure-release", [
    "schemaVersion", "worldId", "releaseId", "sourceId", "corridorId", "corridorName", "stations", "segments",
    ...(withBoundaryWindows ? ["boundaryPlanningWindows"] : []),
  ]);
  invariant(input["schemaVersion"] === PLANNING_INFRASTRUCTURE_RELEASE_SCHEMA, "Planning-Infrastrukturrelease hat ein unbekanntes Schema.");
  for (const key of ["worldId", "releaseId", "sourceId", "corridorId", "corridorName"] as const) text(input[key], `planning.infrastructure-release.${key}`);
  if (expectedWorldId !== undefined) invariant(input["worldId"] === expectedWorldId, "Planning-Infrastrukturrelease verletzt die Weltisolation.");
  if (expectedReleaseId !== undefined) invariant(input["releaseId"] === expectedReleaseId, "Planning-Infrastrukturrelease besitzt eine fremde ID.");
  invariant(Array.isArray(input["stations"]) && input["stations"].length >= 2, "Planning-Infrastrukturrelease braucht mindestens zwei Betriebsstellen.");
  invariant(Array.isArray(input["segments"]) && input["segments"].length >= 1, "Planning-Infrastrukturrelease braucht mindestens ein Segment.");
  input["stations"].forEach(validateStation);
  input["segments"].forEach(validateSegment);
  if (withBoundaryWindows) {
    invariant(Array.isArray(input["boundaryPlanningWindows"]), "Planning-Infrastrukturrelease besitzt keine Grenzfensterliste.");
    const ids = new Set<string>();
    for (const [index, value] of input["boundaryPlanningWindows"].entries()) {
      const name = `planning.infrastructure-release.boundaryPlanningWindows[${index}]`;
      const window = exactRecord(value, name, [
        "id", "playableLegId", "originStationId", "destinationStationId", "qualityClass", "orderable", "windows",
      ]);
      for (const key of ["id", "playableLegId", "originStationId", "destinationStationId"] as const) text(window[key], `${name}.${key}`);
      invariant(!ids.has(window["id"] as string), `${name}.id ist doppelt.`);
      ids.add(window["id"] as string);
      invariant(["A", "B", "C"].includes(window["qualityClass"] as string), `${name}.qualityClass ist unbekannt.`);
      invariant(typeof window["orderable"] === "boolean", `${name}.orderable fehlt.`);
      invariant(Array.isArray(window["windows"]) && window["windows"].length >= 1 && window["windows"].length <= 2, `${name}.windows braucht ein oder zwei Fenster.`);
      const directions = new Set<string>();
      for (const [windowIndex, fact] of window["windows"].entries()) {
        const factName = `${name}.windows[${windowIndex}]`;
        const parsed = exactRecord(fact, factName, ["windowId", "portalId", "direction", "earliestS", "targetS", "latestS"]);
        text(parsed["windowId"], `${factName}.windowId`);
        text(parsed["portalId"], `${factName}.portalId`);
        invariant(parsed["direction"] === "entry" || parsed["direction"] === "exit", `${factName}.direction ist unbekannt.`);
        invariant(!directions.has(parsed["direction"] as string), `${name} besitzt eine Grenzrichtung doppelt.`);
        directions.add(parsed["direction"] as string);
        integer(parsed["earliestS"], `${factName}.earliestS`);
        integer(parsed["targetS"], `${factName}.targetS`);
        integer(parsed["latestS"], `${factName}.latestS`);
        invariant((parsed["earliestS"] as number) <= (parsed["targetS"] as number) && (parsed["targetS"] as number) <= (parsed["latestS"] as number), `${factName} ist nicht monoton.`);
      }
    }
  }
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
  formationId: nonEmptyString,
  operatorId: nonEmptyString,
  fleetRevision: nonNegativeInteger,
  fleetStateHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  fleetAuthorityReleaseId: nonEmptyString,
  boundaryPlanningWindowId: nonEmptyString,
  trainId: nonEmptyString,
  trainCategory: { enum: ["long-distance", "suburban", "regional", "freight", "supplementary"] },
  trainNumber: positiveInteger,
  originStationId: nonEmptyString,
  destinationStationId: nonEmptyString,
  desiredDepartureS: nonNegativeInteger,
  operatingDays: { enum: ["daily", "workdays", "weekend"] },
  serviceWindow: {
    type: "object", additionalProperties: false, required: ["validFromS", "validUntilS"],
    properties: { validFromS: nonNegativeInteger, validUntilS: positiveInteger },
  },
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
    required: ["numericId", "name", "massKg", "lengthMm", "maximumSpeedMmps", "accelerationMmPerS2", "decelerationMmPerS2"],
    properties: {
      numericId: nonNegativeInteger, name: nonEmptyString, massKg: positiveInteger, lengthMm: positiveInteger,
      maximumSpeedMmps: positiveInteger, accelerationMmPerS2: positiveInteger, decelerationMmPerS2: positiveInteger,
    },
  },
} as const;

const playerPathRequestProperties = {
  ...pathRequestProperties,
  schemaVersion: { type: "string", const: PLANNING_PLAYER_PATH_REQUEST_SCHEMA },
  trainId: undefined,
  trainNumber: undefined,
  train: undefined,
  fleetRevision: undefined,
  fleetStateHash: undefined,
  fleetAuthorityReleaseId: undefined,
} as const;

/** Fastify-kompatibler exakter Body fuer den nichtautoritativen Spielerpfad. */
export const PLANNING_PLAYER_PATH_REQUEST_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", ...PLAYER_REQUEST_KEYS],
  properties: Object.fromEntries(
    Object.entries(playerPathRequestProperties).filter(([, value]) => value !== undefined),
  ),
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
