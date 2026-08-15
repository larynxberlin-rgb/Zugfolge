import type {
  LivemapObjectKind,
  PublicMapEstimate,
  PublicMapPosition,
  PublicObjectState,
} from "@zugfolge/livemap-stream";

export type OperatingStatus =
  | "planned"
  | "running"
  | "waiting"
  | "at_platform"
  | "completed"
  | "cancelled";

export const PUBLIC_OPERATION_MARKER_SCHEMA = "zugfolge-livemap-operation-marker/v1" as const;
export const DISRUPTION_MARKER_SCHEMA = "zugfolge-livemap-disruption/v1" as const;
export const PUBLIC_OPERATOR_LABEL = "Eigenbetrieb des Aufgabenträgers";

export interface PublicOperationMarker {
  readonly schemaVersion: typeof PUBLIC_OPERATION_MARKER_SCHEMA;
  readonly kind: "public-operator";
}

export interface PublicDisruptionMarker {
  readonly schemaVersion: typeof DISRUPTION_MARKER_SCHEMA;
  readonly disruptionId: string;
  readonly causeCode: number;
  readonly causeLabel: string;
  readonly fineCauseId: string;
  readonly fineCauseLabel: string;
  readonly effect: "closure" | "single-track" | "speed-restriction" | "platform-change" | "traffic-hold" | "route-deviation" | "vehicle-restriction" | "platform-usable-length";
  readonly affectedResource: string;
  readonly validUntilS: number;
}

export interface PublicInfrastructureDisruption extends PublicDisruptionMarker {
  readonly kind: "planned" | "unplanned";
  readonly positionMm: number;
  readonly publishedAtS: number;
  readonly startsAtS: number;
}

export interface PublicTrain {
  readonly id: string;
  readonly operatorId?: string;
  readonly operator: string;
  readonly trainNumber: string;
  readonly category: string;
  readonly positionMm: number;
  readonly speedMmPerSecond: number;
  readonly delaySeconds: number;
  readonly nextOperatingPoint: string;
  readonly status: OperatingStatus;
  readonly mapPosition?: PublicMapPosition;
  readonly mapEstimate?: PublicMapEstimate;
  readonly operationMarker?: PublicOperationMarker;
  readonly disruption?: PublicDisruptionMarker;
}

export interface PublicExternalTrain {
  readonly id: string;
  readonly operator: string;
  readonly trainNumber: string;
  readonly category: string;
  readonly journeyChainId: string;
  readonly externalLegId: string;
  readonly fromPortalId: string;
  readonly toPortalId: string | null;
  readonly scheduledEndS: number;
  readonly reentryEarliestS: number | null;
  readonly reentryLatestS: number | null;
  readonly delaySeconds: number;
  readonly status: "outside" | "ready-at-boundary" | "waiting-for-capacity" | "completed-outside";
  readonly progressBasisPoints: number;
}

export interface Snapshot {
  readonly worldId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly at: number;
  readonly trains: readonly PublicTrain[];
  readonly externalTrains?: readonly PublicExternalTrain[];
  readonly disruptions?: readonly PublicInfrastructureDisruption[];
  readonly objectStates?: readonly PublicObjectState[];
}

export interface Delta {
  readonly worldId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly at: number;
  readonly changed: readonly PublicTrain[];
  readonly removed: readonly string[];
  readonly changedExternalTrains?: readonly PublicExternalTrain[];
  readonly removedExternalTrainIds?: readonly string[];
  readonly changedDisruptions?: readonly PublicInfrastructureDisruption[];
  readonly removedDisruptionIds?: readonly string[];
  readonly changedObjectStates?: readonly PublicObjectState[];
  readonly removedObjectStateIds?: readonly string[];
}

export interface LiveState {
  readonly worldId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly at: number;
  readonly trains: ReadonlyMap<string, PublicTrain>;
  readonly externalTrains: ReadonlyMap<string, PublicExternalTrain>;
  readonly disruptions: ReadonlyMap<string, PublicInfrastructureDisruption>;
  readonly objectStates: ReadonlyMap<string, PublicObjectState>;
}

export interface RenderSamples {
  readonly previous: LiveState;
  readonly current: LiveState;
}

const OPERATING_STATUSES = new Set<OperatingStatus>([
  "planned",
  "running",
  "waiting",
  "at_platform",
  "completed",
  "cancelled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Livemap-Feld '${field}' muss eine nichtleere Zeichenkette sein.`);
  }
  return value;
}

function streamIdField(record: Record<string, unknown>): string {
  const value = stringField(record, "streamId");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError("Livemap-Feld 'streamId' ist keine gueltige Transportkennung.");
  }
  return value;
}

function integerField(
  record: Record<string, unknown>,
  field: string,
  minimum = Number.MIN_SAFE_INTEGER,
): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`Livemap-Feld '${field}' muss eine sichere Ganzzahl sein.`);
  }
  return value as number;
}

function optionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Livemap-Feld '${field}' muss eine nichtleere Zeichenkette sein.`);
  }
  return value;
}

function parseMapPosition(value: unknown): PublicMapPosition | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError("Livemap-Kartenposition muss ein Objekt sein.");
  const latitudeE7 = integerField(value, "latitudeE7", -900_000_000);
  const longitudeE7 = integerField(value, "longitudeE7", -1_800_000_000);
  if (latitudeE7 > 900_000_000 || longitudeE7 > 1_800_000_000) {
    throw new TypeError("Livemap-Kartenposition liegt ausserhalb des gueltigen Koordinatenraums.");
  }
  const bearingMilliDegrees = value["bearingMilliDegrees"] === undefined
    ? undefined
    : integerField(value, "bearingMilliDegrees", 0);
  if (bearingMilliDegrees !== undefined && bearingMilliDegrees >= 360_000) {
    throw new TypeError("Livemap-Kartenrichtung muss kleiner als 360 Grad sein.");
  }
  return Object.freeze({
    infrastructureReleaseId: stringField(value, "infrastructureReleaseId"),
    resourceId: stringField(value, "resourceId"),
    trackId: stringField(value, "trackId"),
    offsetMm: integerField(value, "offsetMm", 0),
    latitudeE7,
    longitudeE7,
    ...(bearingMilliDegrees === undefined ? {} : { bearingMilliDegrees }),
  });
}

const MAP_ESTIMATE_METHODS = new Set<PublicMapEstimate["method"]>([
  "topological-track",
  "route-corridor",
  "anchor-hold",
]);

function parseMapEstimate(value: unknown): PublicMapEstimate | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError("Livemap-Kartenschaetzung muss ein Objekt sein.");
  const method = stringField(value, "method");
  if (!MAP_ESTIMATE_METHODS.has(method as PublicMapEstimate["method"])) {
    throw new TypeError(`Unbekannte Livemap-Schaetzmethode '${method}'.`);
  }
  const latitudeE7 = integerField(value, "latitudeE7", -900_000_000);
  const longitudeE7 = integerField(value, "longitudeE7", -1_800_000_000);
  if (latitudeE7 > 900_000_000 || longitudeE7 > 1_800_000_000) {
    throw new TypeError("Livemap-Kartenschaetzung liegt ausserhalb des gueltigen Koordinatenraums.");
  }
  const bearingMilliDegrees = value["bearingMilliDegrees"] === undefined
    ? undefined
    : integerField(value, "bearingMilliDegrees", 0);
  if (bearingMilliDegrees !== undefined && bearingMilliDegrees >= 360_000) {
    throw new TypeError("Livemap-Schaetzrichtung muss kleiner als 360 Grad sein.");
  }
  return Object.freeze({
    infrastructureReleaseId: stringField(value, "infrastructureReleaseId"),
    resourceId: stringField(value, "resourceId"),
    method: method as PublicMapEstimate["method"],
    displayPathId: stringField(value, "displayPathId"),
    displayOffsetMm: integerField(value, "displayOffsetMm", 0),
    latitudeE7,
    longitudeE7,
    ...(bearingMilliDegrees === undefined ? {} : { bearingMilliDegrees }),
    uncertaintyMm: integerField(value, "uncertaintyMm", 0),
  });
}

const LIVEMAP_OBJECT_KINDS = new Set<LivemapObjectKind>([
  "track", "station", "platform", "switch", "signal", "block", "facility", "operating-point", "rail-context",
]);

function parseObjectState(value: unknown): PublicObjectState {
  if (!isRecord(value)) throw new TypeError("Livemap-Infrastrukturzustand muss ein Objekt sein.");
  const objectKind = stringField(value, "objectKind");
  const state = stringField(value, "state");
  if (!LIVEMAP_OBJECT_KINDS.has(objectKind as LivemapObjectKind)) {
    throw new TypeError(`Unbekannte Livemap-Objektart '${objectKind}'.`);
  }
  if (!(["restriction", "closure", "construction"] as const).includes(state as PublicObjectState["state"])) {
    throw new TypeError(`Unbekannter Livemap-Infrastrukturzustand '${state}'.`);
  }
  const disruptionId = optionalStringField(value, "disruptionId");
  const validUntilS = value["validUntilS"] === undefined ? undefined : integerField(value, "validUntilS", 0);
  return Object.freeze({
    id: stringField(value, "id"),
    objectKind: objectKind as LivemapObjectKind,
    objectId: stringField(value, "objectId"),
    state: state as PublicObjectState["state"],
    ...(disruptionId === undefined ? {} : { disruptionId }),
    ...(validUntilS === undefined ? {} : { validUntilS }),
  });
}

function parseObjectStates(value: unknown, field: string): readonly PublicObjectState[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`Livemap-Feld '${field}' muss eine Liste sein.`);
  const states = value.map(parseObjectState);
  if (new Set(states.map((state) => state.id)).size !== states.length) {
    throw new TypeError(`Livemap-Feld '${field}' enthaelt doppelte Infrastrukturzustandskennungen.`);
  }
  return Object.freeze(states);
}

function parseOperationMarker(value: unknown): PublicOperationMarker | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== PUBLIC_OPERATION_MARKER_SCHEMA ||
    value["kind"] !== "public-operator"
  ) {
    throw new TypeError("Livemap-Betriebsmarker hat ein unbekanntes Schema.");
  }
  return Object.freeze({
    schemaVersion: PUBLIC_OPERATION_MARKER_SCHEMA,
    kind: "public-operator",
  });
}

function parseDisruptionMarker(value: unknown): PublicDisruptionMarker | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value["schemaVersion"] !== DISRUPTION_MARKER_SCHEMA) {
    throw new TypeError("Livemap-Störungsmarker hat ein unbekanntes Schema.");
  }
  const causeCode = integerField(value, "causeCode", 0);
  const effect = stringField(value, "effect");
  if (causeCode > 99 || !["closure", "single-track", "speed-restriction", "platform-change", "traffic-hold", "route-deviation", "vehicle-restriction", "platform-usable-length"].includes(effect)) {
    throw new TypeError("Livemap-Störungsmarker enthält eine unbekannte Ursache oder Wirkung.");
  }
  return Object.freeze({
    schemaVersion: DISRUPTION_MARKER_SCHEMA,
    disruptionId: stringField(value, "disruptionId"),
    causeCode,
    causeLabel: stringField(value, "causeLabel"),
    fineCauseId: stringField(value, "fineCauseId"),
    fineCauseLabel: stringField(value, "fineCauseLabel"),
    effect: effect as PublicDisruptionMarker["effect"],
    affectedResource: stringField(value, "affectedResource"),
    validUntilS: integerField(value, "validUntilS", 0),
  });
}

function parseInfrastructureDisruption(value: unknown): PublicInfrastructureDisruption {
  if (!isRecord(value)) throw new TypeError("Livemap-Infrastrukturstörung muss ein Objekt sein.");
  const marker = parseDisruptionMarker(value);
  if (marker === undefined) throw new TypeError("Livemap-Infrastrukturstörung fehlt.");
  const kind = stringField(value, "kind");
  if (kind !== "planned" && kind !== "unplanned") {
    throw new TypeError("Livemap-Infrastrukturstörung ist weder geplant noch ungeplant.");
  }
  const publishedAtS = integerField(value, "publishedAtS", 0);
  const startsAtS = integerField(value, "startsAtS", 0);
  if (publishedAtS > startsAtS) throw new TypeError("Störung wurde nach ihrem Beginn veröffentlicht.");
  return Object.freeze({
    ...marker,
    kind,
    positionMm: integerField(value, "positionMm", 0),
    publishedAtS,
    startsAtS,
  });
}

function parseDisruptions(value: unknown, field: string): readonly PublicInfrastructureDisruption[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`Livemap-Feld '${field}' muss eine Liste sein.`);
  const disruptions = value.map(parseInfrastructureDisruption);
  const identifiers = new Set<string>();
  for (const disruption of disruptions) {
    if (identifiers.has(disruption.disruptionId)) throw new TypeError(`Störung '${disruption.disruptionId}' ist doppelt.`);
    identifiers.add(disruption.disruptionId);
  }
  return Object.freeze(disruptions);
}

function parseTrain(value: unknown): PublicTrain {
  if (!isRecord(value)) throw new TypeError("Livemap-Zugprojektion muss ein Objekt sein.");
  const status = stringField(value, "status");
  if (!OPERATING_STATUSES.has(status as OperatingStatus)) {
    throw new TypeError(`Unbekannter Livemap-Betriebsstatus '${status}'.`);
  }
  const operationMarker = parseOperationMarker(value["operationMarker"]);
  const disruption = parseDisruptionMarker(value["disruption"]);
  const mapPosition = parseMapPosition(value["mapPosition"]);
  const mapEstimate = parseMapEstimate(value["mapEstimate"]);
  if (mapPosition !== undefined && mapEstimate !== undefined) {
    throw new TypeError("Ein Livemap-Zug darf nicht zugleich bestaetigte und geschaetzte Kartenlage besitzen.");
  }
  const operatorId = optionalStringField(value, "operatorId");
  return Object.freeze({
    id: stringField(value, "id"),
    ...(operatorId === undefined ? {} : { operatorId }),
    operator: stringField(value, "operator"),
    trainNumber: stringField(value, "trainNumber"),
    category: stringField(value, "category"),
    positionMm: integerField(value, "positionMm", 0),
    speedMmPerSecond: integerField(value, "speedMmPerSecond", 0),
    delaySeconds: integerField(value, "delaySeconds"),
    nextOperatingPoint: stringField(value, "nextOperatingPoint"),
    status: status as OperatingStatus,
    ...(mapPosition === undefined ? {} : { mapPosition }),
    ...(mapEstimate === undefined ? {} : { mapEstimate }),
    ...(operationMarker === undefined ? {} : { operationMarker }),
    ...(disruption === undefined ? {} : { disruption }),
  });
}

export function operatorLabel(train: PublicTrain): string {
  return train.operationMarker === undefined ? train.operator : PUBLIC_OPERATOR_LABEL;
}

function parseTrains(value: unknown, field: string): readonly PublicTrain[] {
  if (!Array.isArray(value)) throw new TypeError(`Livemap-Feld '${field}' muss eine Liste sein.`);
  const trains = value.map(parseTrain);
  const identifiers = new Set<string>();
  for (const train of trains) {
    if (identifiers.has(train.id)) {
      throw new TypeError(`Livemap-Feld '${field}' enthält Zug '${train.id}' doppelt.`);
    }
    identifiers.add(train.id);
  }
  return Object.freeze(trains);
}

function parseExternalTrain(value: unknown): PublicExternalTrain {
  if (!isRecord(value)) throw new TypeError("Livemap-Aussenlauf muss ein Objekt sein.");
  const status = stringField(value, "status");
  if (!["outside", "ready-at-boundary", "waiting-for-capacity", "completed-outside"].includes(status)) {
    throw new TypeError(`Unbekannter Aussenlaufstatus '${status}'.`);
  }
  const toPortalId = value["toPortalId"];
  if (toPortalId !== null && (typeof toPortalId !== "string" || toPortalId.length === 0)) {
    throw new TypeError("Aussenlauf besitzt kein gueltiges Zielportal.");
  }
  const nullableTime = (field: "reentryEarliestS" | "reentryLatestS") =>
    value[field] === null ? null : integerField(value, field, 0);
  const progressBasisPoints = integerField(value, "progressBasisPoints", 0);
  if (progressBasisPoints > 10_000) throw new TypeError("Aussenlauffortschritt liegt ueber 10000 Basispunkten.");
  return Object.freeze({
    id: stringField(value, "id"),
    operator: stringField(value, "operator"),
    trainNumber: stringField(value, "trainNumber"),
    category: stringField(value, "category"),
    journeyChainId: stringField(value, "journeyChainId"),
    externalLegId: stringField(value, "externalLegId"),
    fromPortalId: stringField(value, "fromPortalId"),
    toPortalId: toPortalId as string | null,
    scheduledEndS: integerField(value, "scheduledEndS", 0),
    reentryEarliestS: nullableTime("reentryEarliestS"),
    reentryLatestS: nullableTime("reentryLatestS"),
    delaySeconds: integerField(value, "delaySeconds"),
    status: status as PublicExternalTrain["status"],
    progressBasisPoints,
  });
}

function parseExternalTrains(value: unknown, field: string): readonly PublicExternalTrain[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`Livemap-Feld '${field}' muss eine Liste sein.`);
  const trains = value.map(parseExternalTrain);
  if (new Set(trains.map((train) => train.id)).size !== trains.length) {
    throw new TypeError(`Livemap-Feld '${field}' enthaelt doppelte Aussenlaeufe.`);
  }
  return Object.freeze(trains);
}

export function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) throw new TypeError("Livemap-Snapshot muss ein Objekt sein.");
  return Object.freeze({
    worldId: stringField(value, "worldId"),
    streamId: streamIdField(value),
    sequence: integerField(value, "sequence", 0),
    at: integerField(value, "at", 0),
    trains: parseTrains(value["trains"], "trains"),
    externalTrains: parseExternalTrains(value["externalTrains"], "externalTrains"),
    disruptions: parseDisruptions(value["disruptions"], "disruptions"),
    objectStates: parseObjectStates(value["objectStates"], "objectStates"),
  });
}

export function parseDelta(value: unknown): Delta {
  if (!isRecord(value)) throw new TypeError("Livemap-Delta muss ein Objekt sein.");
  const removed = value["removed"];
  if (!Array.isArray(removed) || removed.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("Livemap-Feld 'removed' muss eine Liste nichtleerer Zugkennungen sein.");
  }
  const removedDisruptionIds = value["removedDisruptionIds"] ?? [];
  if (!Array.isArray(removedDisruptionIds) || removedDisruptionIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("Livemap-Feld 'removedDisruptionIds' muss eine Liste nichtleerer Kennungen sein.");
  }
  const removedExternalTrainIds = value["removedExternalTrainIds"] ?? [];
  if (!Array.isArray(removedExternalTrainIds) || removedExternalTrainIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("Livemap-Feld 'removedExternalTrainIds' muss eine Liste nichtleerer Zugkennungen sein.");
  }
  const removedObjectStateIds = value["removedObjectStateIds"] ?? [];
  if (!Array.isArray(removedObjectStateIds) || removedObjectStateIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("Livemap-Feld 'removedObjectStateIds' muss eine Liste nichtleerer Kennungen sein.");
  }
  return Object.freeze({
    worldId: stringField(value, "worldId"),
    streamId: streamIdField(value),
    sequence: integerField(value, "sequence", 1),
    at: integerField(value, "at", 0),
    changed: parseTrains(value["changed"], "changed"),
    removed: Object.freeze([...removed] as string[]),
    changedExternalTrains: parseExternalTrains(value["changedExternalTrains"], "changedExternalTrains"),
    removedExternalTrainIds: Object.freeze([...removedExternalTrainIds] as string[]),
    changedDisruptions: parseDisruptions(value["changedDisruptions"], "changedDisruptions"),
    removedDisruptionIds: Object.freeze([...removedDisruptionIds] as string[]),
    changedObjectStates: parseObjectStates(value["changedObjectStates"], "changedObjectStates"),
    removedObjectStateIds: Object.freeze([...removedObjectStateIds] as string[]),
  });
}

export function initialState(snapshot: Snapshot): LiveState {
  const trains = new Map<string, PublicTrain>();
  for (const train of snapshot.trains) {
    if (trains.has(train.id)) throw new TypeError(`Snapshot enthält Zug '${train.id}' doppelt.`);
    trains.set(train.id, Object.freeze({ ...train }));
  }
  const disruptions = new Map<string, PublicInfrastructureDisruption>();
  snapshot.disruptions?.forEach((item) => disruptions.set(item.disruptionId, item));
  const externalTrains = new Map<string, PublicExternalTrain>();
  snapshot.externalTrains?.forEach((train) => externalTrains.set(train.id, train));
  const objectStates = new Map<string, PublicObjectState>();
  snapshot.objectStates?.forEach((state) => objectStates.set(state.id, state));
  return Object.freeze({
    worldId: snapshot.worldId,
    streamId: snapshot.streamId,
    sequence: snapshot.sequence,
    at: snapshot.at,
    trains,
    externalTrains,
    disruptions,
    objectStates,
  });
}

export function applyDelta(state: LiveState, delta: Delta): LiveState | undefined {
  if (
    delta.worldId !== state.worldId ||
    delta.streamId !== state.streamId ||
    delta.sequence !== state.sequence + 1 ||
    delta.at < state.at
  ) {
    return undefined;
  }
  const trains = new Map(state.trains);
  delta.changed.forEach((train) => trains.set(train.id, Object.freeze({ ...train })));
  delta.removed.forEach((id) => trains.delete(id));
  const disruptions = new Map(state.disruptions);
  delta.changedDisruptions?.forEach((item) => disruptions.set(item.disruptionId, item));
  delta.removedDisruptionIds?.forEach((id) => disruptions.delete(id));
  const externalTrains = new Map(state.externalTrains);
  delta.changedExternalTrains?.forEach((train) => externalTrains.set(train.id, train));
  delta.removedExternalTrainIds?.forEach((id) => externalTrains.delete(id));
  const objectStates = new Map(state.objectStates);
  delta.changedObjectStates?.forEach((item) => objectStates.set(item.id, item));
  delta.removedObjectStateIds?.forEach((id) => objectStates.delete(id));
  return Object.freeze({
    worldId: state.worldId,
    streamId: state.streamId,
    sequence: delta.sequence,
    at: delta.at,
    trains,
    externalTrains,
    disruptions,
    objectStates,
  });
}

export function appendRenderSample(
  samples: RenderSamples | undefined,
  authoritativeState: LiveState,
): RenderSamples {
  if (
    samples === undefined ||
    samples.current.worldId !== authoritativeState.worldId ||
    samples.current.streamId !== authoritativeState.streamId ||
    authoritativeState.sequence <= samples.current.sequence ||
    authoritativeState.at <= samples.current.at
  ) {
    return Object.freeze({ previous: authoritativeState, current: authoritativeState });
  }
  return Object.freeze({ previous: samples.current, current: authoritativeState });
}

export function interpolatedPosition(
  previous: PublicTrain,
  current: PublicTrain,
  previousAt: number,
  currentAt: number,
  renderAt: number,
): number {
  if (
    previous.id !== current.id ||
    previous.status !== "running" ||
    current.status !== "running" ||
    currentAt <= previousAt
  ) {
    return current.positionMm;
  }
  if (renderAt <= previousAt) return previous.positionMm;
  if (renderAt >= currentAt) return current.positionMm;
  const elapsed = renderAt - previousAt;
  const duration = currentAt - previousAt;
  return Math.round(previous.positionMm + ((current.positionMm - previous.positionMm) * elapsed) / duration);
}

function interpolateInteger(previous: number, current: number, elapsed: number, duration: number): number {
  return Math.round(previous + ((current - previous) * elapsed) / duration);
}

function interpolateBearing(previous: number | undefined, current: number | undefined, elapsed: number, duration: number): number | undefined {
  if (previous === undefined || current === undefined) return current;
  const delta = ((current - previous + 540_000) % 360_000) - 180_000;
  return (interpolateInteger(previous, previous + delta, elapsed, duration) + 360_000) % 360_000;
}

function interpolatedMapPosition(
  previous: PublicTrain,
  current: PublicTrain,
  previousAt: number,
  currentAt: number,
  renderAt: number,
): PublicMapPosition | undefined {
  const from = previous.mapPosition;
  const to = current.mapPosition;
  if (
    previous.status !== "running"
    || current.status !== "running"
    || from === undefined
    || to === undefined
    || from.infrastructureReleaseId !== to.infrastructureReleaseId
    || from.resourceId !== to.resourceId
    || from.trackId !== to.trackId
    || currentAt <= previousAt
  ) return to;
  if (renderAt <= previousAt) return from;
  if (renderAt >= currentAt) return to;
  const elapsed = renderAt - previousAt;
  const duration = currentAt - previousAt;
  const bearingMilliDegrees = interpolateBearing(
    from.bearingMilliDegrees,
    to.bearingMilliDegrees,
    elapsed,
    duration,
  );
  return Object.freeze({
    ...to,
    offsetMm: interpolateInteger(from.offsetMm, to.offsetMm, elapsed, duration),
    latitudeE7: interpolateInteger(from.latitudeE7, to.latitudeE7, elapsed, duration),
    longitudeE7: interpolateInteger(from.longitudeE7, to.longitudeE7, elapsed, duration),
    ...(bearingMilliDegrees === undefined ? {} : { bearingMilliDegrees }),
  });
}

export function renderTrains(samples: RenderSamples, renderAt: number): readonly PublicTrain[] {
  return [...samples.current.trains.values()].map((current) => {
    const previous = samples.previous.trains.get(current.id);
    if (previous === undefined) return current;
    const positionMm = interpolatedPosition(
      previous,
      current,
      samples.previous.at,
      samples.current.at,
      renderAt,
    );
    const mapPosition = interpolatedMapPosition(
      previous,
      current,
      samples.previous.at,
      samples.current.at,
      renderAt,
    );
    if (positionMm === current.positionMm && mapPosition === current.mapPosition) return current;
    return Object.freeze({
      ...current,
      positionMm,
      ...(mapPosition === undefined ? {} : { mapPosition }),
    });
  });
}

interface ServerSentEvent {
  readonly type: string;
  readonly data: string;
  readonly lastEventId: string | undefined;
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  dispatch: (event: ServerSentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let eventType = "";
  let lastEventId: string | undefined;
  let firstLine = true;

  const dispatchEvent = () => {
    if (data.length > 0) {
      dispatch({ type: eventType || "message", data: data.join("\n"), lastEventId });
    }
    data = [];
    eventType = "";
    lastEventId = undefined;
  };
  const processLine = (rawLine: string) => {
    const line = firstLine && rawLine.startsWith("\uFEFF") ? rawLine.slice(1) : rawLine;
    firstLine = false;
    if (line === "") {
      dispatchEvent();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") eventType = value;
    else if (field === "id" && !value.includes("\u0000")) lastEventId = value;
  };
  const processCompleteLines = (final: boolean) => {
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (character === "\n") {
        const end = index > start && buffer[index - 1] === "\r" ? index - 1 : index;
        processLine(buffer.slice(start, end));
        start = index + 1;
      } else if (character === "\r") {
        if (index + 1 >= buffer.length && !final) break;
        processLine(buffer.slice(start, index));
        if (buffer[index + 1] === "\n") index += 1;
        start = index + 1;
      }
    }
    buffer = buffer.slice(start);
    if (final && buffer.length > 0) {
      processLine(buffer);
      buffer = "";
    }
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      processCompleteLines(false);
    }
    buffer += decoder.decode();
    processCompleteLines(true);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export interface LivemapConnectionDependencies {
  readonly fetch?: typeof fetch;
  readonly retryDelayMs?: number;
  readonly maximumPendingDeltas?: number;
  readonly onError?: (error: unknown) => void;
}

type RecoveryMode = "resume" | "resnapshot";

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Authentifizierter Snapshot-/SSE-Client. Jeder Stream beginnt beim zuletzt
 * angewendeten Generation-/Sequenz-Cursor. Lücken, Generationwechsel, Reset
 * und Pufferüberlauf führen zu genau einem laufenden Re-Snapshot; ein
 * fehlgeschlagener Resume-Versuch eskaliert immer zu einem Re-Snapshot.
 */
export class LivemapConnection {
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: number;
  readonly #maximumPendingDeltas: number;
  readonly #onError: (error: unknown) => void;
  readonly #accessToken: string | ((forceRefresh?: boolean) => Promise<string>);
  readonly #baseUrl: string;
  #state: LiveState | undefined;
  #synchronization: Promise<void> | undefined;
  #snapshotController: AbortController | undefined;
  #streamController: AbortController | undefined;
  #streamGeneration = 0;
  #bufferIncoming = false;
  #pendingDeltas: Delta[] = [];
  #pendingReset = false;
  #pendingOverflow = false;
  #resnapshotAfterCurrent = false;
  #resumeAfterSynchronization = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #scheduledRecovery: RecoveryMode | undefined;
  #closed = true;

  constructor(
    baseUrl: string,
    private readonly worldId: string,
    accessToken: string | ((forceRefresh?: boolean) => Promise<string>),
    private readonly changed: (state: LiveState) => void,
    dependencies: LivemapConnectionDependencies = {},
  ) {
    if (worldId.length === 0) throw new RangeError("Livemap-Weltkennung darf nicht leer sein.");
    if (typeof accessToken === "string" && accessToken.trim().length === 0) throw new RangeError("Livemap-Zugriffstoken darf nicht leer sein.");
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#accessToken = accessToken;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#retryDelayMs = dependencies.retryDelayMs ?? 1_000;
    this.#maximumPendingDeltas = dependencies.maximumPendingDeltas ?? 256;
    this.#onError = dependencies.onError ?? (() => undefined);
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 0) {
      throw new RangeError("retryDelayMs muss eine nichtnegative Ganzzahl sein.");
    }
    if (!Number.isSafeInteger(this.#maximumPendingDeltas) || this.#maximumPendingDeltas <= 0) {
      throw new RangeError("maximumPendingDeltas muss eine positive Ganzzahl sein.");
    }
  }

  async #authorization(forceRefresh = false): Promise<string> {
    const token = typeof this.#accessToken === "string" ? this.#accessToken : await this.#accessToken(forceRefresh);
    return `Bearer ${token}`;
  }

  async #authorizedFetch(url: string, init: RequestInit): Promise<Response> {
    if (typeof this.#accessToken === "string") {
      return this.#fetch.call(globalThis, url, { ...init, headers: { ...init.headers, authorization: `Bearer ${this.#accessToken}` } });
    }
    const request = async (forceRefresh = false): Promise<Response> => this.#fetch.call(globalThis, url, {
      ...init,
      headers: { ...init.headers, authorization: await this.#authorization(forceRefresh) },
    });
    let response = await request();
    if ((response.status === 401 || response.status === 403) && typeof this.#accessToken !== "string") response = await request(true);
    return response;
  }

  async connect(): Promise<void> {
    if (!this.#closed) {
      await this.#synchronization;
      return;
    }
    this.#closed = false;
    this.#bufferIncoming = true;
    this.#pendingDeltas = [];
    this.#pendingReset = false;
    this.#pendingOverflow = false;
    try {
      await this.#resynchronize();
    } catch (error) {
      this.#handleRecoveryFailure(error, "resnapshot");
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#bufferIncoming = false;
    this.#pendingDeltas = [];
    this.#pendingReset = false;
    this.#pendingOverflow = false;
    this.#resnapshotAfterCurrent = false;
    this.#resumeAfterSynchronization = false;
    this.#cancelRetry();
    this.#snapshotController?.abort();
    this.#snapshotController = undefined;
    this.#streamGeneration += 1;
    this.#streamController?.abort();
    this.#streamController = undefined;
  }

  #snapshotUrl(): string {
    return `${this.#baseUrl}/worlds/${encodeURIComponent(this.worldId)}/livemap/snapshot`;
  }

  #eventsUrl(): string {
    return `${this.#baseUrl}/worlds/${encodeURIComponent(this.worldId)}/livemap/events`;
  }

  async #fetchSnapshot(): Promise<LiveState> {
    const controller = new AbortController();
    this.#snapshotController = controller;
    try {
      const response = await this.#authorizedFetch(this.#snapshotUrl(), {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Livemap-Snapshot: HTTP ${response.status}`);
      const snapshot = parseSnapshot(await response.json());
      if (snapshot.worldId !== this.worldId) {
        throw new Error("Livemap-Snapshot gehört zur falschen Welt.");
      }
      return initialState(snapshot);
    } finally {
      if (this.#snapshotController === controller) this.#snapshotController = undefined;
    }
  }

  #resynchronize(): Promise<void> {
    if (this.#synchronization !== undefined) return this.#synchronization;
    this.#bufferIncoming = true;
    let completed = false;
    const operation = this.#reloadAndResume().then(() => {
      completed = true;
    });
    let tracked: Promise<void>;
    tracked = operation.finally(() => {
      if (this.#synchronization === tracked) this.#synchronization = undefined;
      const followup = this.#resnapshotAfterCurrent;
      const resume = this.#resumeAfterSynchronization;
      this.#resnapshotAfterCurrent = false;
      this.#resumeAfterSynchronization = false;
      if (!this.#closed && completed && followup) this.#requestResnapshot();
      else if (!this.#closed && completed && resume) this.#scheduleRecovery("resume");
    });
    this.#synchronization = tracked;
    return tracked;
  }

  async #reloadAndResume(): Promise<void> {
    let state = await this.#fetchSnapshot();
    const drain = this.#drainPending(state);
    state = drain.state;
    this.#state = state;
    this.changed(state);

    if (drain.needsResnapshot) {
      this.#resnapshotAfterCurrent = true;
      return;
    }

    this.#bufferIncoming = false;
    await this.#replaceStream(state.streamId, state.sequence);
  }

  #drainPending(snapshot: LiveState): { readonly state: LiveState; readonly needsResnapshot: boolean } {
    let state = snapshot;
    let needsResnapshot = this.#pendingReset || this.#pendingOverflow;
    this.#pendingReset = false;
    this.#pendingOverflow = false;
    const pending = this.#pendingDeltas.splice(0);
    if (needsResnapshot) return { state, needsResnapshot };

    for (const delta of pending) {
      if (delta.worldId !== this.worldId || delta.streamId !== state.streamId) {
        needsResnapshot = true;
        break;
      }
      if (delta.sequence <= state.sequence) continue;
      const next = applyDelta(state, delta);
      if (next === undefined) {
        needsResnapshot = true;
        break;
      }
      state = next;
    }
    return { state, needsResnapshot };
  }

  #requestResnapshot(): void {
    if (this.#closed) return;
    this.#bufferIncoming = true;
    this.#cancelRetry();
    const operation = this.#resynchronize();
    void operation.catch((error: unknown) => this.#handleRecoveryFailure(error, "resnapshot"));
  }

  #accept(delta: Delta): void {
    if (this.#closed) return;
    if (this.#bufferIncoming) {
      this.#buffer(delta);
      return;
    }
    const next = this.#state === undefined ? undefined : applyDelta(this.#state, delta);
    if (next === undefined) {
      this.#buffer(delta);
      this.#requestResnapshot();
      return;
    }
    this.#state = next;
    this.changed(next);
  }

  #buffer(delta: Delta): void {
    if (this.#pendingOverflow) return;
    if (this.#pendingDeltas.length >= this.#maximumPendingDeltas) {
      this.#pendingDeltas = [];
      this.#pendingOverflow = true;
      return;
    }
    this.#pendingDeltas.push(delta);
  }

  #handleServerEvent(event: ServerSentEvent): void {
    if (event.type === "reset") {
      if (this.#bufferIncoming) this.#pendingReset = true;
      else this.#requestResnapshot();
      return;
    }
    if (event.type !== "message") return;
    try {
      const delta = parseDelta(JSON.parse(event.data) as unknown);
      if (event.lastEventId !== undefined && event.lastEventId !== "") {
        const expectedEventId = `${delta.streamId}:${delta.sequence}`;
        if (event.lastEventId !== expectedEventId) {
          throw new TypeError("SSE-Ereigniskennung und Delta-Cursor stimmen nicht überein.");
        }
      }
      this.#accept(delta);
    } catch (error) {
      this.#onError(error);
      if (this.#bufferIncoming) this.#pendingReset = true;
      else this.#requestResnapshot();
    }
  }

  async #replaceStream(streamId: string, sequence: number): Promise<void> {
    this.#streamGeneration += 1;
    const generation = this.#streamGeneration;
    this.#streamController?.abort();
    const controller = new AbortController();
    this.#streamController = controller;

    let response: Response;
    try {
      response = await this.#authorizedFetch(this.#eventsUrl(), {
        cache: "no-store",
        headers: {
          accept: "text/event-stream",
          "last-event-id": `${streamId}:${sequence}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Livemap-Stream: HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/event-stream")) {
        throw new Error("Livemap-Stream hat keinen text/event-stream-Inhaltstyp.");
      }
      if (response.body === null) throw new Error("Livemap-Stream besitzt keinen Antwortkörper.");
    } catch (error) {
      if (this.#streamGeneration === generation) this.#streamController = undefined;
      controller.abort();
      throw error;
    }

    if (this.#closed || this.#streamGeneration !== generation) {
      controller.abort();
      return;
    }

    const body = response.body;
    void consumeEventStream(body, (event) => this.#handleServerEvent(event), controller.signal).then(
      () => this.#streamFinished(generation, undefined),
      (error: unknown) => this.#streamFinished(generation, error),
    );
  }

  #streamFinished(generation: number, error: unknown): void {
    if (this.#closed || generation !== this.#streamGeneration) return;
    this.#streamController = undefined;
    if (error !== undefined && !abortError(error)) this.#onError(error);
    if (this.#bufferIncoming || this.#synchronization !== undefined) {
      if (!this.#bufferIncoming) this.#resumeAfterSynchronization = true;
      return;
    }
    this.#scheduleRecovery("resume");
  }

  #scheduleRecovery(mode: RecoveryMode): void {
    if (this.#closed) return;
    if (this.#retryTimer !== undefined) {
      if (mode === "resnapshot") this.#scheduledRecovery = "resnapshot";
      return;
    }
    this.#scheduledRecovery = mode;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      const scheduled = this.#scheduledRecovery;
      this.#scheduledRecovery = undefined;
      if (this.#closed || scheduled === undefined) return;
      if (scheduled === "resnapshot" || this.#state === undefined) {
        this.#requestResnapshot();
        return;
      }
      void this.#replaceStream(this.#state.streamId, this.#state.sequence).catch((error: unknown) => {
        this.#handleRecoveryFailure(error, "resnapshot");
      });
    }, this.#retryDelayMs);
  }

  #handleRecoveryFailure(error: unknown, next: RecoveryMode): void {
    if (this.#closed || abortError(error)) return;
    this.#onError(error);
    this.#scheduleRecovery(next);
  }

  #cancelRetry(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#scheduledRecovery = undefined;
  }
}
