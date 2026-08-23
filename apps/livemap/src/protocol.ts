import type {
  LivemapObjectKind,
  PublicMapPosition,
  PublicObjectState,
  PublicOperationalDisruption,
  PublicOperationalDisruptionEffect,
  PublicOperationalRegionFrame,
  PublicOperationalSignalAspect,
  PublicOperationalTrainState,
  PublicOperationalVehicleRestriction,
  PublicRouteGeometryPoint,
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
  readonly delaySeconds?: number;
  readonly nextOperatingPoint?: string;
  readonly status: OperatingStatus;
  readonly operational?: PublicOperationalTrainState;
  readonly mapPosition?: PublicMapPosition;
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
  readonly operationalRegions?: readonly PublicOperationalRegionFrame[];
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
  readonly changedOperationalRegions?: readonly PublicOperationalRegionFrame[];
  readonly removedOperationalRegionIds?: readonly string[];
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
  readonly operationalRegions: ReadonlyMap<string, PublicOperationalRegionFrame>;
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
  const operatorId = optionalStringField(value, "operatorId");
  const operational = parseOperationalState(value["operational"]);
  const delaySeconds = value["delaySeconds"] === undefined
    ? undefined
    : integerField(value, "delaySeconds");
  const nextOperatingPoint = optionalStringField(value, "nextOperatingPoint");
  return Object.freeze({
    id: stringField(value, "id"),
    ...(operatorId === undefined ? {} : { operatorId }),
    operator: stringField(value, "operator"),
    trainNumber: stringField(value, "trainNumber"),
    category: stringField(value, "category"),
    positionMm: integerField(value, "positionMm", 0),
    speedMmPerSecond: integerField(value, "speedMmPerSecond", 0),
    ...(delaySeconds === undefined ? {} : { delaySeconds }),
    ...(nextOperatingPoint === undefined ? {} : { nextOperatingPoint }),
    status: status as OperatingStatus,
    ...(operational === undefined ? {} : { operational }),
    ...(mapPosition === undefined ? {} : { mapPosition }),
    ...(operationMarker === undefined ? {} : { operationMarker }),
    ...(disruption === undefined ? {} : { disruption }),
  });
}

function parseOperationalState(value: unknown): PublicOperationalTrainState | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError("Exakter Betriebszustand muss ein Objekt sein.");
  const movementKind = stringField(value, "movementKind");
  const direction = stringField(value, "direction");
  if (movementKind !== "train" && movementKind !== "shunting") {
    throw new TypeError("Unbekannte Bewegungsart im Betriebszustand.");
  }
  if (direction !== "along" && direction !== "against") {
    throw new TypeError("Unbekannte Fahrtrichtung im Betriebszustand.");
  }
  if (!Array.isArray(value["occupiedIntervals"]) || !Array.isArray(value["occupiedBlocks"])) {
    throw new TypeError("Exakter Betriebszustand besitzt keine Belegungsmenge.");
  }
  const occupiedIntervals = value["occupiedIntervals"].map((item) => {
    if (!isRecord(item)) throw new TypeError("Gleisintervall muss ein Objekt sein.");
    const intervalDirection = stringField(item, "direction");
    if (intervalDirection !== "along" && intervalDirection !== "against") {
      throw new TypeError("Gleisintervall besitzt keine Richtung.");
    }
    const fromMm = integerField(item, "fromMm", 0);
    const toMm = integerField(item, "toMm", 1);
    if (fromMm >= toMm) throw new TypeError("Gleisintervall ist leer oder umgekehrt.");
    return Object.freeze({
      trackId: stringField(item, "trackId"),
      fromMm,
      toMm,
      direction: intervalDirection,
    });
  });
  const occupiedBlocks = value["occupiedBlocks"].map((item) => {
    if (typeof item !== "string" || item.length === 0) throw new TypeError("Blockkennung fehlt.");
    return item;
  });
  const motionSegment = value["motionSegment"] === undefined
    ? undefined
    : parseMotionSegment(value["motionSegment"]);
  const authorityEndRouteMm = value["authorityEndRouteMm"] === undefined
    ? undefined
    : integerField(value, "authorityEndRouteMm", 0);
  const waitingReason = optionalStringField(value, "waitingReason");
  const result: PublicOperationalTrainState = Object.freeze({
    regionId: stringField(value, "regionId"),
    commitSequence: integerField(value, "commitSequence", 0),
    simulationTimeMs: integerField(value, "simulationTimeMs", 0),
    routeVersionId: stringField(value, "routeVersionId"),
    formationVersionId: stringField(value, "formationVersionId"),
    movementKind,
    headRouteMm: integerField(value, "headRouteMm", 0),
    tailRouteMm: integerField(value, "tailRouteMm"),
    direction,
    occupiedIntervals: Object.freeze(occupiedIntervals),
    occupiedBlocks: Object.freeze(occupiedBlocks),
    ...(authorityEndRouteMm === undefined ? {} : { authorityEndRouteMm }),
    ...(motionSegment === undefined ? {} : { motionSegment }),
    ...(waitingReason === undefined ? {} : { waitingReason }),
  });
  if (result.tailRouteMm > result.headRouteMm) throw new TypeError("Zugschluss liegt vor der Zugspitze.");
  return result;
}

function parseMotionSegment(value: unknown): NonNullable<PublicOperationalTrainState["motionSegment"]> {
  if (!isRecord(value) || !Array.isArray(value["geometry"])) {
    throw new TypeError("Bewegungsabschnitt ist unvollstaendig.");
  }
  const geometry: PublicRouteGeometryPoint[] = value["geometry"].map((point) => {
    if (!isRecord(point)) throw new TypeError("Laufweggeometriepunkt muss ein Objekt sein.");
    const bearing = point["bearingMilliDegrees"] === undefined
      ? undefined
      : integerField(point, "bearingMilliDegrees", 0);
    return Object.freeze({
      routeMm: integerField(point, "routeMm", 0),
      trackId: stringField(point, "trackId"),
      offsetMm: integerField(point, "offsetMm", 0),
      latitudeE7: integerField(point, "latitudeE7", -900_000_000),
      longitudeE7: integerField(point, "longitudeE7", -1_800_000_000),
      ...(bearing === undefined ? {} : { bearingMilliDegrees: bearing }),
    });
  });
  if (geometry.length < 2 || geometry.some((point, index) => index > 0 && point.routeMm <= geometry[index - 1]!.routeMm)) {
    throw new TypeError("Laufweggeometrie ist nicht streng geordnet.");
  }
  const startedAtMs = integerField(value, "startedAtMs", 0);
  const validUntilMs = integerField(value, "validUntilMs", 0);
  const startRouteMm = integerField(value, "startRouteMm", 0);
  const authorityEndRouteMm = integerField(value, "authorityEndRouteMm", 0);
  const segmentEndRouteMm = integerField(value, "segmentEndRouteMm", 0);
  if (validUntilMs < startedAtMs) throw new TypeError("Bewegungsabschnitt endet vor seinem Beginn.");
  if (startRouteMm > segmentEndRouteMm || segmentEndRouteMm > authorityEndRouteMm) {
    throw new TypeError("Bewegungsabschnitt verletzt Abschnitts- oder Fahrberechtigungsende.");
  }
  return Object.freeze({
    startedAtMs,
    validUntilMs,
    startRouteMm,
    startSpeedMmPerSecond: integerField(value, "startSpeedMmPerSecond", 0),
    accelerationMmPerSecondSquared: integerField(value, "accelerationMmPerSecondSquared"),
    authorityEndRouteMm,
    segmentEndRouteMm,
    geometry: Object.freeze(geometry),
  });
}

const OPERATIONAL_SIGNAL_ASPECTS = new Set<PublicOperationalSignalAspect>([
  "stop",
  "proceed",
  "shunting-proceed",
  "failed",
]);

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function parseOperationalVehicleRestriction(value: unknown): PublicOperationalVehicleRestriction {
  if (value === "immobilized") return value;
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new TypeError("Operative Fahrzeugstoerung besitzt keine eindeutige Wirkung.");
  }
  const [kind] = Object.keys(value);
  const amount = value[kind!];
  if (kind === "protection-unavailable") {
    if (typeof amount !== "string" || amount.length === 0) {
      throw new TypeError("Operative Zugsicherungseinschraenkung ist ungueltig.");
    }
  } else if (
    ![
      "power-basis-points",
      "maximum-speed",
      "service-brake",
      "emergency-brake",
      "door-availability-basis-points",
    ].includes(kind!)
    || !Number.isSafeInteger(amount)
    || (amount as number) < 0
    || ((kind === "power-basis-points" || kind === "door-availability-basis-points")
      && (amount as number) > 65_535)
  ) {
    throw new TypeError("Operative Fahrzeugeinschraenkung ist ungueltig.");
  }
  return Object.freeze({ [kind!]: amount }) as PublicOperationalVehicleRestriction;
}

function parseOperationalDisruptionEffect(value: unknown): PublicOperationalDisruptionEffect {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    throw new TypeError("Operative Stoerung besitzt keine eindeutige Wirkung.");
  }
  const [kind] = Object.keys(value);
  const detail = value[kind!];
  if (!isRecord(detail)) throw new TypeError("Operative Stoerungswirkung muss ein Objekt sein.");
  let projected: Readonly<Record<string, unknown>>;
  switch (kind) {
    case "resource-closed":
    case "track-detection-failed":
      if (!hasExactKeys(detail, ["resourceId"])) throw new TypeError("Operative Ressourcenstoerung ist ungueltig.");
      projected = Object.freeze({ resourceId: stringField(detail, "resourceId") });
      break;
    case "signal-failed":
      if (!hasExactKeys(detail, ["signalId"])) throw new TypeError("Operativer Signalausfall ist ungueltig.");
      projected = Object.freeze({ signalId: stringField(detail, "signalId") });
      break;
    case "switch-failed":
      if (!hasExactKeys(detail, ["switchId"])) throw new TypeError("Operativer Weichenausfall ist ungueltig.");
      projected = Object.freeze({ switchId: stringField(detail, "switchId") });
      break;
    case "speed-restriction":
      if (!hasExactKeys(detail, ["edgeId", "maximumSpeedMmps"])) throw new TypeError("Operative Langsamfahrstelle ist ungueltig.");
      projected = Object.freeze({
        edgeId: stringField(detail, "edgeId"),
        maximumSpeedMmps: integerField(detail, "maximumSpeedMmps", 1),
      });
      break;
    case "vehicle-restricted":
      if (!hasExactKeys(detail, ["vehicleId", "restriction"])) throw new TypeError("Operative Fahrzeugstoerung ist ungueltig.");
      projected = Object.freeze({
        vehicleId: stringField(detail, "vehicleId"),
        restriction: parseOperationalVehicleRestriction(detail["restriction"]),
      });
      break;
    default:
      throw new TypeError("Operative Stoerung besitzt eine unbekannte Wirkung.");
  }
  return Object.freeze({ [kind!]: projected }) as PublicOperationalDisruptionEffect;
}

function parseOperationalDisruption(value: unknown): PublicOperationalDisruption {
  if (!isRecord(value) || !hasExactKeys(value, ["disruptionId", "effect"])) {
    throw new TypeError("Aktive operative Stoerung ist unvollstaendig.");
  }
  return Object.freeze({
    disruptionId: stringField(value, "disruptionId"),
    effect: parseOperationalDisruptionEffect(value["effect"]),
  });
}

function parseOperationalRegionFrame(value: unknown): PublicOperationalRegionFrame {
  if (
    !isRecord(value)
    || !Array.isArray(value["routeLocks"])
    || !isRecord(value["signals"])
    || !Array.isArray(value["activeDisruptions"])
  ) {
    throw new TypeError("Operativer Regionsframe ist unvollstaendig.");
  }
  const simulationTimeMs = integerField(value, "simulationTimeMs", 0);
  const staleAfterMs = integerField(value, "staleAfterMs", 0);
  if (staleAfterMs < simulationTimeMs) {
    throw new TypeError("Operativer Regionsframe ist bereits bei Veroeffentlichung veraltet.");
  }
  const routeLocks = value["routeLocks"].map((lock) => {
    if (!isRecord(lock) || !Array.isArray(lock["resources"])) {
      throw new TypeError("Fahrstrassenverriegelung ist unvollstaendig.");
    }
    const resources = lock["resources"].map((resource) => {
      if (typeof resource !== "string" || resource.length === 0) {
        throw new TypeError("Fahrstrassenverriegelung besitzt eine leere Ressource.");
      }
      return resource;
    });
    if (resources.length === 0 || new Set(resources).size !== resources.length) {
      throw new TypeError("Fahrstrassenverriegelung besitzt keine eindeutige Ressourcenmenge.");
    }
    const lockedAtMs = integerField(lock, "lockedAtMs", 0);
    if (lockedAtMs > simulationTimeMs) {
      throw new TypeError("Fahrstrassenverriegelung liegt nach dem Regionscommit.");
    }
    return Object.freeze({
      id: stringField(lock, "id"),
      templateId: stringField(lock, "templateId"),
      trainId: stringField(lock, "trainId"),
      resources: Object.freeze(resources),
      releaseAfterTailRouteMm: integerField(lock, "releaseAfterTailRouteMm", 0),
      lockedAtMs,
    });
  });
  if (new Set(routeLocks.map((lock) => lock.id)).size !== routeLocks.length) {
    throw new TypeError("Operativer Regionsframe besitzt doppelte Fahrstrassenverriegelungen.");
  }
  const signals: Record<string, PublicOperationalSignalAspect> = {};
  for (const [signalId, aspect] of Object.entries(value["signals"])) {
    if (signalId.length === 0 || !OPERATIONAL_SIGNAL_ASPECTS.has(aspect as PublicOperationalSignalAspect)) {
      throw new TypeError("Operativer Regionsframe besitzt einen unbekannten Signalbegriff.");
    }
    signals[signalId] = aspect as PublicOperationalSignalAspect;
  }
  const activeDisruptions = value["activeDisruptions"].map(parseOperationalDisruption);
  if (new Set(activeDisruptions.map((disruption) => disruption.disruptionId)).size !== activeDisruptions.length) {
    throw new TypeError("Operativer Regionsframe besitzt doppelte aktive Stoerungen.");
  }
  return Object.freeze({
    regionId: stringField(value, "regionId"),
    infrastructureReleaseId: stringField(value, "infrastructureReleaseId"),
    commitSequence: integerField(value, "commitSequence", 0),
    simulationTimeMs,
    staleAfterMs,
    routeLocks: Object.freeze(routeLocks),
    signals: Object.freeze(signals),
    activeDisruptions: Object.freeze(activeDisruptions),
  });
}

function parseOperationalRegions(value: unknown, field: string): readonly PublicOperationalRegionFrame[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError(`Livemap-Feld '${field}' muss eine Liste sein.`);
  const frames = value.map(parseOperationalRegionFrame);
  if (new Set(frames.map((frame) => frame.regionId)).size !== frames.length) {
    throw new TypeError(`Livemap-Feld '${field}' enthaelt doppelte operative Regionen.`);
  }
  return Object.freeze(frames);
}

function assertOperationalBindings(
  trains: ReadonlyMap<string, PublicTrain>,
  regions: ReadonlyMap<string, PublicOperationalRegionFrame>,
): void {
  for (const train of trains.values()) {
    const operational = train.operational;
    if (operational === undefined) continue;
    const frame = regions.get(operational.regionId);
    const mapPosition = train.mapPosition;
    if (
      frame === undefined ||
      mapPosition === undefined ||
      mapPosition.infrastructureReleaseId !== frame.infrastructureReleaseId ||
      operational.commitSequence !== frame.commitSequence ||
      operational.simulationTimeMs !== frame.simulationTimeMs
    ) {
      throw new TypeError(`Zug '${train.id}' ist nicht atomar an seinen operativen Regionsframe gebunden.`);
    }
  }
  for (const frame of regions.values()) {
    for (const lock of frame.routeLocks) {
      const train = trains.get(lock.trainId);
      if (train?.operational?.regionId !== frame.regionId) {
        throw new TypeError(`Fahrstrasse '${lock.id}' ist nicht an einen Zug ihres Regionsframes gebunden.`);
      }
    }
  }
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
  const trains = parseTrains(value["trains"], "trains");
  const operationalRegions = parseOperationalRegions(value["operationalRegions"], "operationalRegions");
  assertOperationalBindings(
    new Map(trains.map((train) => [train.id, train] as const)),
    new Map(operationalRegions.map((frame) => [frame.regionId, frame] as const)),
  );
  return Object.freeze({
    worldId: stringField(value, "worldId"),
    streamId: streamIdField(value),
    sequence: integerField(value, "sequence", 0),
    at: integerField(value, "at", 0),
    trains,
    externalTrains: parseExternalTrains(value["externalTrains"], "externalTrains"),
    disruptions: parseDisruptions(value["disruptions"], "disruptions"),
    objectStates: parseObjectStates(value["objectStates"], "objectStates"),
    operationalRegions,
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
  const changedOperationalRegions = parseOperationalRegions(
    value["changedOperationalRegions"],
    "changedOperationalRegions",
  );
  const removedOperationalRegionIds = value["removedOperationalRegionIds"] ?? [];
  if (
    !Array.isArray(removedOperationalRegionIds) ||
    removedOperationalRegionIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(removedOperationalRegionIds).size !== removedOperationalRegionIds.length ||
    removedOperationalRegionIds.some((id) =>
      changedOperationalRegions.some((frame) => frame.regionId === id)
    )
  ) {
    throw new TypeError("Operative Regionsframes muessen eindeutig und disjunkt geaendert oder entfernt werden.");
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
    changedOperationalRegions,
    removedOperationalRegionIds: Object.freeze([...removedOperationalRegionIds] as string[]),
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
  const operationalRegions = new Map<string, PublicOperationalRegionFrame>();
  snapshot.operationalRegions?.forEach((frame) => {
    if (operationalRegions.has(frame.regionId)) {
      throw new TypeError(`Snapshot enthaelt Region '${frame.regionId}' doppelt.`);
    }
    operationalRegions.set(frame.regionId, frame);
  });
  assertOperationalBindings(trains, operationalRegions);
  return Object.freeze({
    worldId: snapshot.worldId,
    streamId: snapshot.streamId,
    sequence: snapshot.sequence,
    at: snapshot.at,
    trains,
    externalTrains,
    disruptions,
    objectStates,
    operationalRegions,
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
  const operationalRegions = new Map(state.operationalRegions);
  for (const frame of delta.changedOperationalRegions ?? []) {
    const previous = operationalRegions.get(frame.regionId);
    if (
      previous !== undefined && (
        frame.commitSequence !== previous.commitSequence + 1 ||
        frame.simulationTimeMs < previous.simulationTimeMs
      )
    ) {
      return undefined;
    }
    operationalRegions.set(frame.regionId, frame);
  }
  delta.removedOperationalRegionIds?.forEach((regionId) => operationalRegions.delete(regionId));
  try {
    assertOperationalBindings(trains, operationalRegions);
  } catch {
    return undefined;
  }
  return Object.freeze({
    worldId: state.worldId,
    streamId: state.streamId,
    sequence: delta.sequence,
    at: delta.at,
    trains,
    externalTrains,
    disruptions,
    objectStates,
    operationalRegions,
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

function operationalPositionAt(
  state: PublicOperationalTrainState,
  renderAtMs: number,
): { readonly routeMm: number; readonly speedMmPerSecond: number } {
  const segment = state.motionSegment;
  if (segment === undefined || renderAtMs <= segment.startedAtMs) {
    return { routeMm: state.headRouteMm, speedMmPerSecond: 0 };
  }
  const atMs = Math.min(renderAtMs, segment.validUntilMs);
  const elapsedMs = atMs - segment.startedAtMs;
  const elapsed = BigInt(elapsedMs);
  const velocityDistance = divideRoundHalfAway(
    BigInt(segment.startSpeedMmPerSecond) * elapsed,
    1_000n,
  );
  const accelerationDistance = divideRoundHalfAway(
    BigInt(segment.accelerationMmPerSecondSquared) * elapsed * elapsed,
    2_000_000n,
  );
  const distance = safeBigIntNumber(
    velocityDistance + accelerationDistance,
    "operativer Bewegungsweg",
  );
  const routeMm = Math.min(
    segment.authorityEndRouteMm,
    segment.segmentEndRouteMm,
    Math.max(segment.startRouteMm, segment.startRouteMm + distance),
  );
  const speedMmPerSecond = routeMm >= Math.min(segment.authorityEndRouteMm, segment.segmentEndRouteMm)
    ? 0
    : Math.max(0, safeBigIntNumber(
      BigInt(segment.startSpeedMmPerSecond) + divideRoundHalfAway(
        BigInt(segment.accelerationMmPerSecondSquared) * elapsed,
        1_000n,
      ),
      "operative Geschwindigkeit",
    ));
  return { routeMm, speedMmPerSecond };
}

/** Identische Ganzzahlrundung wie der Rust-Kern: exakte Halbe von null weg. */
function divideRoundHalfAway(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("Rundungsnenner muss positiv sein.");
  return numerator >= 0n
    ? (numerator + denominator / 2n) / denominator
    : (numerator - denominator / 2n) / denominator;
}

function safeBigIntNumber(value: bigint, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} liegt ausserhalb des sicheren Ganzzahlbereichs.`);
  return result;
}

function operationalMapPosition(
  train: PublicTrain,
  routeMm: number,
): PublicMapPosition | undefined {
  const segment = train.operational?.motionSegment;
  const infrastructureReleaseId = train.mapPosition?.infrastructureReleaseId;
  if (segment === undefined || infrastructureReleaseId === undefined) return train.mapPosition;
  const after = segment.geometry.find((point) => point.routeMm >= routeMm) ?? segment.geometry.at(-1);
  if (after === undefined) return train.mapPosition;
  const afterIndex = segment.geometry.indexOf(after);
  const before = segment.geometry[Math.max(0, afterIndex - 1)] ?? after;
  const duration = after.routeMm - before.routeMm;
  const elapsed = Math.max(0, routeMm - before.routeMm);
  const bearingMilliDegrees = interpolateBearing(
    before.bearingMilliDegrees,
    after.bearingMilliDegrees,
    elapsed,
    duration || 1,
  );
  return Object.freeze({
    infrastructureReleaseId,
    resourceId: train.operational?.occupiedBlocks[0] ?? train.mapPosition?.resourceId ?? after.trackId,
    trackId: duration === 0 ? after.trackId : before.trackId,
    offsetMm: interpolateInteger(before.offsetMm, after.offsetMm, elapsed, duration || 1),
    latitudeE7: interpolateInteger(before.latitudeE7, after.latitudeE7, elapsed, duration || 1),
    longitudeE7: interpolateInteger(before.longitudeE7, after.longitudeE7, elapsed, duration || 1),
    ...(bearingMilliDegrees === undefined ? {} : { bearingMilliDegrees }),
  });
}

export function renderTrains(samples: RenderSamples, renderAt: number): readonly PublicTrain[] {
  return [...samples.current.trains.values()].map((current) => {
    const operational = current.operational;
    if (operational !== undefined) {
      const frame = samples.current.operationalRegions.get(operational.regionId);
      if (frame === undefined) return current;
      const renderAtMs = Math.min(Math.round(renderAt * 1_000), frame.staleAfterMs);
      const position = operationalPositionAt(operational, renderAtMs);
      const travelledMm = position.routeMm - operational.headRouteMm;
      const projectedOperational = Object.freeze({
        ...operational,
        simulationTimeMs: Math.min(
          renderAtMs,
          operational.motionSegment?.validUntilMs ?? operational.simulationTimeMs,
        ),
        headRouteMm: position.routeMm,
        tailRouteMm: operational.tailRouteMm + travelledMm,
      });
      const mapPosition = operationalMapPosition(current, position.routeMm);
      return Object.freeze({
        ...current,
        positionMm: position.routeMm,
        speedMmPerSecond: position.speedMmPerSecond,
        operational: projectedOperational,
        ...(mapPosition === undefined ? {} : { mapPosition }),
      });
    }
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
    if (
      positionMm === current.positionMm
      && mapPosition === current.mapPosition
    ) return current;
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
  /** Stoppt jede visuelle Fortschreibung bis ein atomarer Re-Snapshot eintrifft. */
  readonly onFreeze?: () => void;
}

type RecoveryMode = "resnapshot";

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Authentifizierter Snapshot-/SSE-Client. Jeder Stream beginnt beim zuletzt
 * angewendeten Generation-/Sequenz-Cursor. Lücken, Verbindungsende,
 * Generationwechsel, Reset und Pufferüberlauf frieren die Darstellung sofort
 * ein und führen zu genau einem laufenden Re-Snapshot.
 */
export class LivemapConnection {
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: number;
  readonly #maximumPendingDeltas: number;
  readonly #onError: (error: unknown) => void;
  readonly #onFreeze: () => void;
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
    this.#onFreeze = dependencies.onFreeze ?? (() => undefined);
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
    this.#cancelRetry();
    this.#onFreeze();
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
      this.#resnapshotAfterCurrent = false;
      if (!this.#closed && completed && followup) this.#requestResnapshot();
    });
    this.#synchronization = tracked;
    return tracked;
  }

  async #reloadAndResume(): Promise<void> {
    let state = await this.#fetchSnapshot();
    let drain = this.#drainPending(state);
    state = drain.state;
    this.#state = state;

    if (drain.needsResnapshot) {
      this.#resnapshotAfterCurrent = true;
      return;
    }

    await this.#replaceStream(state.streamId, state.sequence);
    if (this.#closed || this.#resnapshotAfterCurrent || this.#streamController === undefined) {
      return;
    }

    // Deltas des alten oder gerade etablierten Streams bleiben bis zum
    // erfolgreichen Handshake gepuffert. Erst ein lückenloser Snapshot-
    // Stream-Verbund darf die eingefrorene Darstellung wieder freigeben.
    drain = this.#drainPending(state);
    state = drain.state;
    this.#state = state;
    if (drain.needsResnapshot) {
      this.#resnapshotAfterCurrent = true;
      return;
    }
    this.#bufferIncoming = false;
    this.changed(state);
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
    this.#onFreeze();
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
    this.#onFreeze();
    if (this.#bufferIncoming || this.#synchronization !== undefined) {
      this.#resnapshotAfterCurrent = true;
      return;
    }
    this.#scheduleRecovery("resnapshot");
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
      this.#requestResnapshot();
    }, this.#retryDelayMs);
  }

  #handleRecoveryFailure(error: unknown, next: RecoveryMode): void {
    if (this.#closed || abortError(error)) return;
    this.#onFreeze();
    this.#onError(error);
    this.#scheduleRecovery(next);
  }

  #cancelRetry(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#scheduledRecovery = undefined;
  }
}
