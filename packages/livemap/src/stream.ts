import type { HealthCheck } from "@zugfolge/health";

function compareUtf8(left: string, right: string): number {
  const Encoder = (globalThis as unknown as {
    readonly TextEncoder?: new () => { encode(value: string): Uint8Array };
  }).TextEncoder;
  if (Encoder === undefined) throw new Error("UTF-8-Encoder ist nicht verfuegbar.");
  const encoder = new Encoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function randomStreamId(): string {
  const cryptoProvider = (globalThis as unknown as {
    readonly crypto?: { readonly randomUUID?: () => string };
  }).crypto;
  const randomUUID = cryptoProvider?.randomUUID;
  if (randomUUID === undefined) {
    throw new Error("Sichere Livemap-Stream-ID-Erzeugung ist nicht verfuegbar.");
  }
  return randomUUID.call(cryptoProvider);
}

export const PUBLIC_OPERATION_MARKER_SCHEMA = "zugfolge-livemap-operation-marker/v1" as const;
export const DISRUPTION_MARKER_SCHEMA = "zugfolge-livemap-disruption/v1" as const;

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

/** Eigenständiger Infrastrukturmarker; nicht an einen sichtbaren Zug gebunden. */
export interface PublicInfrastructureDisruption extends PublicDisruptionMarker {
  readonly kind: "planned" | "unplanned";
  readonly positionMm: number;
  readonly publishedAtS: number;
  readonly startsAtS: number;
  /** Nur aus einer autoritativen Baustellenklassifikation, niemals aus Freitext. */
  readonly authoritativeObjectState?: "construction";
}

export interface PublicOperationMarker {
  readonly schemaVersion: typeof PUBLIC_OPERATION_MARKER_SCHEMA;
  readonly kind: "public-operator";
}

/** Ganzzahlige, georeferenzierte Kartenposition aus dem gepinnten InfraRelease. */
export interface PublicMapPosition {
  readonly infrastructureReleaseId: string;
  readonly resourceId: string;
  readonly trackId: string;
  readonly offsetMm: number;
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  readonly bearingMilliDegrees?: number;
}

export interface PublicTrackInterval {
  readonly trackId: string;
  readonly fromMm: number;
  readonly toMm: number;
  readonly direction: "along" | "against";
}

export interface PublicRouteGeometryPoint {
  readonly routeMm: number;
  readonly trackId: string;
  readonly offsetMm: number;
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  readonly bearingMilliDegrees?: number;
}

function validRouteGeometryPoint(point: PublicRouteGeometryPoint): boolean {
  return !(!Number.isSafeInteger(point.routeMm) || point.routeMm < 0
      || !Number.isSafeInteger(point.offsetMm) || point.offsetMm < 0 || point.trackId.length === 0
      || !Number.isSafeInteger(point.latitudeE7) || Math.abs(point.latitudeE7) > 900_000_000
      || !Number.isSafeInteger(point.longitudeE7) || Math.abs(point.longitudeE7) > 1_800_000_000
      || (point.bearingMilliDegrees !== undefined && (!Number.isSafeInteger(point.bearingMilliDegrees)
        || point.bearingMilliDegrees < 0 || point.bearingMilliDegrees >= 360_000)));
}

/** Gleiswechsel behalten beide Offsets am selben, exakt verbundenen Punkt. */
export function isContinuousRouteGeometry(geometry: readonly PublicRouteGeometryPoint[]): boolean {
  return geometry.length >= 2 && geometry.every((point, index) => {
    if (!validRouteGeometryPoint(point)) return false;
    const previous = geometry[index - 1];
    if (previous === undefined) return true;
    if (point.routeMm > previous.routeMm) return point.trackId === previous.trackId;
    return point.routeMm === previous.routeMm && point.trackId !== previous.trackId
      && point.latitudeE7 === previous.latitudeE7 && point.longitudeE7 === previous.longitudeE7
      && geometry[index - 2]?.routeMm !== point.routeMm;
  });
}

/** Vom Server autorisierter, unveraenderlicher analytischer Bewegungsabschnitt. */
export interface PublicMotionSegment {
  readonly startedAtMs: number;
  readonly validUntilMs: number;
  readonly startRouteMm: number;
  readonly startSpeedMmPerSecond: number;
  readonly accelerationMmPerSecondSquared: number;
  readonly authorityEndRouteMm: number;
  readonly segmentEndRouteMm: number;
  readonly geometry: readonly PublicRouteGeometryPoint[];
}

/** Ein räumlich leerer Bremsrest braucht genau einen gebundenen Ort. */
export function isMotionSegmentGeometry(segment: Pick<PublicMotionSegment,
  "geometry" | "startRouteMm" | "segmentEndRouteMm" | "startedAtMs" | "validUntilMs">): boolean {
  const point = segment.geometry[0];
  if (segment.startRouteMm === segment.segmentEndRouteMm) {
    return segment.validUntilMs > segment.startedAtMs && segment.geometry.length === 1
      && point !== undefined && validRouteGeometryPoint(point) && point.routeMm === segment.startRouteMm;
  }
  return isContinuousRouteGeometry(segment.geometry)
    && point!.routeMm <= segment.startRouteMm
    && segment.geometry.at(-1)!.routeMm >= segment.segmentEndRouteMm;
}

/** Exakte betriebliche v2-Sicht; LiveMap und RZUE verwenden dieselbe Instanz. */
export interface PublicOperationalTrainState {
  readonly regionId: string;
  readonly commitSequence: number;
  readonly simulationTimeMs: number;
  readonly routeVersionId: string;
  readonly formationVersionId: string;
  readonly movementKind: "train" | "shunting";
  readonly headRouteMm: number;
  readonly tailRouteMm: number;
  readonly direction: "along" | "against";
  readonly occupiedIntervals: readonly PublicTrackInterval[];
  readonly occupiedBlocks: readonly string[];
  readonly authorityEndRouteMm?: number;
  readonly motionSegment?: PublicMotionSegment;
  readonly waitingReason?: string;
}

export type PublicOperationalSignalAspect = "stop" | "proceed" | "shunting-proceed" | "failed";

export type PublicOperationalVehicleRestriction =
  | Readonly<{ "power-basis-points": number }>
  | Readonly<{ "maximum-speed": number }>
  | Readonly<{ "service-brake": number }>
  | Readonly<{ "emergency-brake": number }>
  | Readonly<{ "protection-unavailable": string }>
  | Readonly<{ "door-availability-basis-points": number }>
  | "immobilized";

export type PublicOperationalDisruptionEffect =
  | Readonly<{ "resource-closed": Readonly<{ resourceId: string }> }>
  | Readonly<{ "speed-restriction": Readonly<{ edgeId: string; maximumSpeedMmps: number }> }>
  | Readonly<{ "signal-failed": Readonly<{ signalId: string }> }>
  | Readonly<{ "switch-failed": Readonly<{ switchId: string }> }>
  | Readonly<{ "track-detection-failed": Readonly<{ resourceId: string }> }>
  | Readonly<{
      "vehicle-restricted": Readonly<{
        vehicleId: string;
        restriction: PublicOperationalVehicleRestriction;
      }>;
    }>;

export interface PublicOperationalDisruption {
  readonly disruptionId: string;
  readonly effect: PublicOperationalDisruptionEffect;
}

export interface PublicOperationalRouteLock {
  readonly id: string;
  readonly templateId: string;
  readonly trainId: string;
  readonly resources: readonly string[];
  readonly releaseAfterTailRouteMm: number;
  readonly lockedAtMs: number;
}

/**
 * Gemeinsamer committed Regionskopf fuer LiveMap und RZUE. Der Frame wird im
 * selben Feed-Delta wie die zugehoerigen Zugzustaende ersetzt.
 */
export interface PublicOperationalRegionFrame {
  readonly regionId: string;
  readonly infrastructureReleaseId: string;
  readonly commitSequence: number;
  readonly simulationTimeMs: number;
  readonly staleAfterMs: number;
  readonly routeLocks: readonly PublicOperationalRouteLock[];
  readonly signals: Readonly<Record<string, PublicOperationalSignalAspect>>;
  readonly activeDisruptions: readonly PublicOperationalDisruption[];
}

export type LivemapObjectKind =
  | "track"
  | "rail-context"
  | "station"
  | "platform"
  | "switch"
  | "signal"
  | "block"
  | "facility"
  | "operating-point";

/**
 * Sparse Abweichung vom Normalzustand. Fehlt ein Objekt, ist sein Zustand
 * normal; der Stream wiederholt deshalb nicht das gesamte Infrastrukturmodell.
 */
export interface PublicObjectState {
  readonly id: string;
  readonly objectKind: LivemapObjectKind;
  readonly objectId: string;
  readonly state: "restriction" | "closure" | "construction";
  readonly disruptionId?: string;
  readonly validUntilS?: number;
}

export const PUBLIC_OPERATION_MARKER: PublicOperationMarker = Object.freeze({
  schemaVersion: PUBLIC_OPERATION_MARKER_SCHEMA,
  kind: "public-operator",
});

export interface PublicTrain {
  readonly id: string;
  /** Vom autoritativen Runtimevertrag gelieferte Basisfahrt für Tagesinstanzen. */
  readonly baseTrainRunId?: string;
  readonly operatorId?: string;
  readonly operator: string;
  readonly trainNumber: string;
  readonly category: string;
  readonly positionMm: number;
  readonly speedMmPerSecond: number;
  /** Nur vorhanden, wenn aus dem autoritativen Fahrplanvergleich abgeleitet. */
  readonly delaySeconds?: number;
  /** Nur vorhanden, wenn ein autoritativer naechster Betriebspunkt feststeht. */
  readonly nextOperatingPoint?: string;
  readonly status: string;
  readonly operational?: PublicOperationalTrainState;
  readonly mapPosition?: PublicMapPosition;
  readonly operationMarker?: PublicOperationMarker;
  readonly disruption?: PublicDisruptionMarker;
}

/**
 * Reine, synchrone Exact-Projektion an der Fanout-Grenze. Ohne beweisbare
 * `mapPosition` bleibt der sichere letzte Zustand stehen; es gibt keinen
 * Schaetzvertrag.
 */
export interface PublicTrainMapProjector {
  project(worldId: string, train: PublicTrain): PublicTrain;
  projectExternal?(worldId: string, train: PublicExternalTrain): PublicExternalTrain;
}

/** Liefert eine Basisfahrt ausschliesslich fuer die kanonische `base:day-N`-Bindung. */
export function verifiedBaseTrainRunId(train: PublicTrain): string | undefined {
  const base = train.baseTrainRunId;
  if (base === undefined || base.includes(":day-")) return undefined;
  const prefix = `${base}:day-`;
  if (!train.id.startsWith(prefix)) return undefined;
  return /^[1-9][0-9]*$/u.test(train.id.slice(prefix.length)) ? base : undefined;
}

/** Leitet nur nachgewiesene Gleisabweichungen aus einer Ressourcenstoerung ab. */
export interface PublicObjectStateProjector {
  projectDisruption(
    worldId: string,
    disruption: PublicInfrastructureDisruption,
  ): readonly PublicObjectState[];
}

/** Sichtbarer Aussenlauf ohne erfundene Kartenposition. */
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

/**
 * Explizite Allowlist an der oeffentlichen Grenze. Der regionale Runtime-Wert
 * darf intern zusaetzliche Kosten-, Fahrzeug- und Personaldaten tragen; sie
 * verlassen den Server ueber den Livemap-Fanout niemals.
 */
function publicExternalTrain(train: PublicExternalTrain): PublicExternalTrain {
  return Object.freeze({
    id: train.id,
    operator: train.operator,
    trainNumber: train.trainNumber,
    category: train.category,
    journeyChainId: train.journeyChainId,
    externalLegId: train.externalLegId,
    fromPortalId: train.fromPortalId,
    toPortalId: train.toPortalId,
    scheduledEndS: train.scheduledEndS,
    reentryEarliestS: train.reentryEarliestS,
    reentryLatestS: train.reentryLatestS,
    delaySeconds: train.delaySeconds,
    status: train.status,
    progressBasisPoints: train.progressBasisPoints,
  });
}

function validateMapProjection(train: PublicTrain): void {
  const position = train.mapPosition;
  const integer = (value: number) => Number.isSafeInteger(value);
  if (position !== undefined && (
    position.trackId.length === 0 ||
    position.infrastructureReleaseId.length === 0 ||
    position.resourceId.length === 0 ||
    !integer(position.offsetMm) || position.offsetMm < 0 ||
    !integer(position.latitudeE7) || position.latitudeE7 < -900_000_000 || position.latitudeE7 > 900_000_000 ||
    !integer(position.longitudeE7) || position.longitudeE7 < -1_800_000_000 || position.longitudeE7 > 1_800_000_000 ||
    (position.bearingMilliDegrees !== undefined && (
      !integer(position.bearingMilliDegrees) ||
      position.bearingMilliDegrees < 0 ||
      position.bearingMilliDegrees >= 360_000
    ))
  )) {
    throw new RangeError(`Zug '${train.id}' besitzt keine gueltige ganzzahlige Kartenposition.`);
  }

}

function validateOperationalState(train: PublicTrain): void {
  const state = train.operational;
  if (state === undefined) return;
  const integer = (value: number) => Number.isSafeInteger(value);
  if (
    state.regionId.length === 0 ||
    !integer(state.commitSequence) || state.commitSequence < 0 ||
    !integer(state.simulationTimeMs) || state.simulationTimeMs < 0 ||
    state.routeVersionId.length === 0 || state.formationVersionId.length === 0 ||
    !integer(state.headRouteMm) || !integer(state.tailRouteMm) ||
    state.tailRouteMm > state.headRouteMm ||
    state.occupiedIntervals.some((interval) =>
      interval.trackId.length === 0 || !integer(interval.fromMm) || !integer(interval.toMm) ||
      interval.fromMm < 0 || interval.fromMm >= interval.toMm
    ) ||
    state.occupiedBlocks.some((block) => block.length === 0)
  ) {
    throw new RangeError(`Zug '${train.id}' besitzt keinen gueltigen exakten Betriebszustand.`);
  }
  const segment = state.motionSegment;
  if (segment === undefined) return;
  if (
    !integer(segment.startedAtMs) || !integer(segment.validUntilMs) ||
    segment.validUntilMs < segment.startedAtMs ||
    !integer(segment.startRouteMm) || !integer(segment.startSpeedMmPerSecond) ||
    !integer(segment.accelerationMmPerSecondSquared) ||
    !integer(segment.authorityEndRouteMm) ||
    !integer(segment.segmentEndRouteMm) ||
    segment.startRouteMm > segment.authorityEndRouteMm ||
    segment.startRouteMm > segment.segmentEndRouteMm ||
    segment.segmentEndRouteMm > segment.authorityEndRouteMm ||
    !isMotionSegmentGeometry(segment)
  ) {
    throw new RangeError(`Zug '${train.id}' besitzt keinen gueltigen autorisierten Bewegungsabschnitt.`);
  }
}

function objectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactObjectKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function publicOperationalRestriction(value: unknown): PublicOperationalVehicleRestriction {
  if (value === "immobilized") return value;
  if (!objectRecord(value) || Object.keys(value).length !== 1) {
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

function publicOperationalDisruption(
  disruption: PublicOperationalDisruption,
): PublicOperationalDisruption {
  if (disruption.disruptionId.length === 0 || !objectRecord(disruption.effect)) {
    throw new TypeError("Operative Stoerung besitzt keine gueltige Kennung oder Wirkung.");
  }
  const effect = disruption.effect as unknown as Readonly<Record<string, unknown>>;
  const [kind] = Object.keys(effect);
  if (Object.keys(effect).length !== 1 || kind === undefined || !objectRecord(effect[kind])) {
    throw new TypeError("Operative Stoerung besitzt keine eindeutige Wirkung.");
  }
  const detail = effect[kind];
  let projectedDetail: Readonly<Record<string, unknown>>;
  switch (kind) {
    case "resource-closed":
    case "track-detection-failed":
      if (!exactObjectKeys(detail, ["resourceId"]) || typeof detail["resourceId"] !== "string" || detail["resourceId"].length === 0) {
        throw new TypeError("Operative Ressourcenstoerung ist ungueltig.");
      }
      projectedDetail = Object.freeze({ resourceId: detail["resourceId"] });
      break;
    case "signal-failed":
      if (!exactObjectKeys(detail, ["signalId"]) || typeof detail["signalId"] !== "string" || detail["signalId"].length === 0) {
        throw new TypeError("Operativer Signalausfall ist ungueltig.");
      }
      projectedDetail = Object.freeze({ signalId: detail["signalId"] });
      break;
    case "switch-failed":
      if (!exactObjectKeys(detail, ["switchId"]) || typeof detail["switchId"] !== "string" || detail["switchId"].length === 0) {
        throw new TypeError("Operativer Weichenausfall ist ungueltig.");
      }
      projectedDetail = Object.freeze({ switchId: detail["switchId"] });
      break;
    case "speed-restriction":
      if (
        !exactObjectKeys(detail, ["edgeId", "maximumSpeedMmps"])
        || typeof detail["edgeId"] !== "string"
        || detail["edgeId"].length === 0
        || !Number.isSafeInteger(detail["maximumSpeedMmps"])
        || (detail["maximumSpeedMmps"] as number) <= 0
      ) {
        throw new TypeError("Operative Langsamfahrstelle ist ungueltig.");
      }
      projectedDetail = Object.freeze({
        edgeId: detail["edgeId"],
        maximumSpeedMmps: detail["maximumSpeedMmps"],
      });
      break;
    case "vehicle-restricted":
      if (
        !exactObjectKeys(detail, ["vehicleId", "restriction"])
        || typeof detail["vehicleId"] !== "string"
        || detail["vehicleId"].length === 0
      ) {
        throw new TypeError("Operative Fahrzeugstoerung ist ungueltig.");
      }
      projectedDetail = Object.freeze({
        vehicleId: detail["vehicleId"],
        restriction: publicOperationalRestriction(detail["restriction"]),
      });
      break;
    default:
      throw new TypeError("Operative Stoerung besitzt eine unbekannte Wirkung.");
  }
  return Object.freeze({
    disruptionId: disruption.disruptionId,
    effect: Object.freeze({ [kind]: projectedDetail }) as PublicOperationalDisruptionEffect,
  });
}

function publicOperationalRegionFrame(
  frame: PublicOperationalRegionFrame,
): PublicOperationalRegionFrame {
  const integer = (value: number) => Number.isSafeInteger(value);
  if (
    frame.regionId.length === 0 ||
    frame.infrastructureReleaseId.length === 0 ||
    !integer(frame.commitSequence) || frame.commitSequence < 0 ||
    !integer(frame.simulationTimeMs) || frame.simulationTimeMs < 0 ||
    !integer(frame.staleAfterMs) || frame.staleAfterMs < frame.simulationTimeMs
  ) {
    throw new RangeError("Operativer Regionsframe verletzt Commit-, Zeit- oder Releasebindung.");
  }
  const lockIds = new Set<string>();
  const routeLocks = frame.routeLocks.map((lock) => {
    if (
      lock.id.length === 0 || lock.templateId.length === 0 || lock.trainId.length === 0 ||
      lock.resources.length === 0 || lock.resources.some((resource) => resource.length === 0) ||
      new Set(lock.resources).size !== lock.resources.length ||
      !integer(lock.releaseAfterTailRouteMm) || lock.releaseAfterTailRouteMm < 0 ||
      !integer(lock.lockedAtMs) || lock.lockedAtMs < 0 || lock.lockedAtMs > frame.simulationTimeMs ||
      lockIds.has(lock.id)
    ) {
      throw new RangeError("Operativer Regionsframe besitzt keine gueltige eindeutige Fahrstrassenverriegelung.");
    }
    lockIds.add(lock.id);
    return Object.freeze({
      id: lock.id,
      templateId: lock.templateId,
      trainId: lock.trainId,
      resources: Object.freeze([...lock.resources]),
      releaseAfterTailRouteMm: lock.releaseAfterTailRouteMm,
      lockedAtMs: lock.lockedAtMs,
    });
  });
  const signals = Object.fromEntries(
    Object.entries(frame.signals)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([signalId, aspect]) => {
        if (
          signalId.length === 0 ||
          !["stop", "proceed", "shunting-proceed", "failed"].includes(aspect)
        ) {
          throw new RangeError("Operativer Regionsframe besitzt einen unbekannten Signalbegriff.");
        }
        return [signalId, aspect] as const;
      }),
  );
  const activeDisruptions = [...frame.activeDisruptions]
    .sort((left, right) => compareUtf8(left.disruptionId, right.disruptionId))
    .map(publicOperationalDisruption);
  if (new Set(activeDisruptions.map((disruption) => disruption.disruptionId)).size !== activeDisruptions.length) {
    throw new RangeError("Operativer Regionsframe besitzt doppelte aktive Stoerungen.");
  }
  return Object.freeze({
    regionId: frame.regionId,
    infrastructureReleaseId: frame.infrastructureReleaseId,
    commitSequence: frame.commitSequence,
    simulationTimeMs: frame.simulationTimeMs,
    staleAfterMs: frame.staleAfterMs,
    routeLocks: Object.freeze(routeLocks),
    signals: Object.freeze(signals),
    activeDisruptions: Object.freeze(activeDisruptions),
  });
}

function sameTrainProjection(left: PublicTrain, right: PublicTrain): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicObjectState(state: PublicObjectState): PublicObjectState {
  if (
    state.id.length === 0 ||
    state.objectId.length === 0 ||
    !["track", "rail-context", "station", "platform", "switch", "signal", "block", "facility", "operating-point"].includes(state.objectKind) ||
    !["restriction", "closure", "construction"].includes(state.state) ||
    (state.disruptionId !== undefined && state.disruptionId.length === 0) ||
    (state.validUntilS !== undefined && (!Number.isSafeInteger(state.validUntilS) || state.validUntilS < 0))
  ) {
    throw new TypeError("Livemap-Infrastrukturzustand verletzt den sparsamen v1-Vertrag.");
  }
  return Object.freeze({
    id: state.id,
    objectKind: state.objectKind,
    objectId: state.objectId,
    state: state.state,
    ...(state.disruptionId === undefined ? {} : { disruptionId: state.disruptionId }),
    ...(state.validUntilS === undefined ? {} : { validUntilS: state.validUntilS }),
  });
}

export interface LiveSnapshot {
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

export interface LiveDelta {
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

export type DeltaListener = (delta: LiveDelta) => void;
export type ResetListener = () => void;

export interface LivemapCursor {
  readonly streamId: string;
  readonly sequence: number;
}

function validStreamId(streamId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(streamId);
}

export function livemapEventId(cursor: LivemapCursor): string {
  if (!validStreamId(cursor.streamId) || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0) {
    throw new RangeError("Livemap-Cursor ist ungueltig.");
  }
  return `${cursor.streamId}:${cursor.sequence}`;
}

export function parseLivemapEventId(value: string): LivemapCursor | undefined {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const streamId = value.slice(0, separator);
  const sequenceText = value.slice(separator + 1);
  if (!validStreamId(streamId) || !/^(0|[1-9][0-9]*)$/.test(sequenceText)) return undefined;
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence)) return undefined;
  return Object.freeze({ streamId, sequence });
}

interface OperationMarkerChange {
  readonly operationMarker: PublicOperationMarker | null;
  readonly effectiveAt: number;
}

export type LivemapSubscription =
  | {
      readonly kind: "resume";
      readonly replay: readonly LiveDelta[];
      readonly unsubscribe: () => void;
    }
  | {
      readonly kind: "reset";
      readonly unsubscribe: () => void;
    };

/** Weltisolierter, begrenzt gepufferter In-Process-Fanout. */
export class LivemapFeed {
  readonly #worldId: string;
  readonly #streamId: string;
  readonly #historyLimit: number;
  readonly #now: () => number;
  #sequence = 0;
  #at = 0;
  #lastPublishedAtMs: number | undefined;
  readonly #trains = new Map<string, PublicTrain>();
  readonly #externalTrains = new Map<string, PublicExternalTrain>();
  readonly #disruptions = new Map<string, PublicInfrastructureDisruption>();
  readonly #objectStates = new Map<string, PublicObjectState>();
  readonly #operationalRegions = new Map<string, PublicOperationalRegionFrame>();
  readonly #operationMarkerTimelines = new Map<string, OperationMarkerChange[]>();
  readonly #latestOperationMarkers = new Map<string, OperationMarkerChange>();
  readonly #listeners = new Set<Readonly<{
    delta: DeltaListener;
    reset?: ResetListener;
  }>>();
  readonly #history: LiveDelta[] = [];

  constructor(
    worldId: string,
    historyLimit = 256,
    now: () => number = Date.now,
    streamId = randomStreamId(),
  ) {
    if (worldId.length === 0) throw new RangeError("worldId darf nicht leer sein.");
    if (!Number.isSafeInteger(historyLimit) || historyLimit <= 0) {
      throw new RangeError("historyLimit muss eine positive Ganzzahl sein.");
    }
    if (!validStreamId(streamId)) {
      throw new RangeError("streamId muss eine nichtleere opaque Transportkennung sein.");
    }
    this.#worldId = worldId;
    this.#streamId = streamId;
    this.#historyLimit = historyLimit;
    this.#now = now;
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  get lastPublishedAtMs(): number | undefined {
    return this.#lastPublishedAtMs;
  }

  snapshot(): LiveSnapshot {
    return {
      worldId: this.#worldId,
      streamId: this.#streamId,
      sequence: this.#sequence,
      at: this.#at,
      trains: [...this.#trains.values()].sort((a, b) => compareUtf8(a.id, b.id)),
      externalTrains: [...this.#externalTrains.values()].sort((a, b) => compareUtf8(a.id, b.id)),
      disruptions: [...this.#disruptions.values()].sort((a, b) => compareUtf8(a.disruptionId, b.disruptionId)),
      objectStates: [...this.#objectStates.values()].sort((a, b) => compareUtf8(a.id, b.id)),
      operationalRegions: [...this.#operationalRegions.values()].sort((a, b) => compareUtf8(a.regionId, b.regionId)),
    };
  }

  #emit(input: Omit<LiveDelta, "worldId" | "streamId" | "sequence">): LiveDelta {
    input.changed.forEach((train) => {
      validateMapProjection(train);
      validateOperationalState(train);
    });
    const changedOperationalRegions = (input.changedOperationalRegions ?? [])
      .map(publicOperationalRegionFrame);
    const changedOperationalRegionIds = new Set(
      changedOperationalRegions.map((frame) => frame.regionId),
    );
    const removedOperationalRegionIds = input.removedOperationalRegionIds ?? [];
    if (
      changedOperationalRegionIds.size !== changedOperationalRegions.length ||
      new Set(removedOperationalRegionIds).size !== removedOperationalRegionIds.length ||
      removedOperationalRegionIds.some((regionId) => regionId.length === 0) ||
      removedOperationalRegionIds.some((regionId) => changedOperationalRegionIds.has(regionId))
    ) {
      throw new RangeError("Geaenderte und entfernte operative Regionsframes muessen eindeutig und disjunkt sein.");
    }
    const nextOperationalRegions = new Map(this.#operationalRegions);
    changedOperationalRegions.forEach((frame) => nextOperationalRegions.set(frame.regionId, frame));
    removedOperationalRegionIds.forEach((regionId) => nextOperationalRegions.delete(regionId));
    const nextTrains = new Map(this.#trains);
    input.changed.forEach((train) => nextTrains.set(train.id, train));
    input.removed.forEach((id) => nextTrains.delete(id));
    for (const train of input.changed) {
      const state = train.operational;
      if (state === undefined) continue;
      const frame = nextOperationalRegions.get(state.regionId);
      if (
        frame === undefined ||
        frame.commitSequence !== state.commitSequence ||
        frame.simulationTimeMs !== state.simulationTimeMs
      ) {
        throw new RangeError(`Geaenderter Zug '${train.id}' gehoert nicht zum publizierten Regionscommit.`);
      }
    }
    for (const train of nextTrains.values()) {
      const state = train.operational;
      if (state === undefined) continue;
      const frame = nextOperationalRegions.get(state.regionId);
      if (
        frame === undefined ||
        frame.commitSequence !== state.commitSequence ||
        frame.simulationTimeMs !== state.simulationTimeMs ||
        (train.mapPosition !== undefined
          && train.mapPosition.infrastructureReleaseId !== frame.infrastructureReleaseId)
      ) {
        throw new RangeError(`Zug '${train.id}' ist nicht an denselben committed Regionsframe gebunden.`);
      }
    }
    const changedObjectStates = input.changedObjectStates?.map(publicObjectState) ?? [];
    const changedObjectStateIds = new Set(changedObjectStates.map((state) => state.id));
    if (changedObjectStateIds.size !== changedObjectStates.length) {
      throw new RangeError("Ein Livemap-Delta darf keine doppelten Infrastrukturzustandskennungen besitzen.");
    }
    const removedObjectStateIds = input.removedObjectStateIds ?? [];
    if (
      removedObjectStateIds.some((id) => id.length === 0) ||
      new Set(removedObjectStateIds).size !== removedObjectStateIds.length ||
      removedObjectStateIds.some((id) => changedObjectStateIds.has(id))
    ) {
      throw new RangeError("Geaenderte und entfernte Infrastrukturzustaende muessen eindeutig und disjunkt sein.");
    }
    input.changed.forEach((train) => this.#trains.set(train.id, train));
    input.removed.forEach((id) => this.#trains.delete(id));
    const changedExternalTrains = input.changedExternalTrains?.map(publicExternalTrain) ?? [];
    changedExternalTrains.forEach((train) => this.#externalTrains.set(train.id, train));
    input.removedExternalTrainIds?.forEach((id) => this.#externalTrains.delete(id));
    input.changedDisruptions?.forEach((disruption) => this.#disruptions.set(disruption.disruptionId, disruption));
    input.removedDisruptionIds?.forEach((id) => this.#disruptions.delete(id));
    changedObjectStates.forEach((state) => this.#objectStates.set(state.id, state));
    removedObjectStateIds.forEach((id) => this.#objectStates.delete(id));
    changedOperationalRegions.forEach((frame) => this.#operationalRegions.set(frame.regionId, frame));
    removedOperationalRegionIds.forEach((regionId) => this.#operationalRegions.delete(regionId));
    this.#sequence += 1;
    this.#at = input.at;
    this.#lastPublishedAtMs = this.#now();
    const delta: LiveDelta = {
      ...input,
      changedDisruptions: input.changedDisruptions ?? [],
      removedDisruptionIds: input.removedDisruptionIds ?? [],
      changedExternalTrains,
      removedExternalTrainIds: input.removedExternalTrainIds ?? [],
      changedObjectStates,
      removedObjectStateIds,
      changedOperationalRegions,
      removedOperationalRegionIds,
      worldId: this.#worldId,
      streamId: this.#streamId,
      sequence: this.#sequence,
    };
    this.#history.push(delta);
    if (this.#history.length > this.#historyLimit) this.#history.shift();
    this.#listeners.forEach((listener) => listener.delta(delta));
    return delta;
  }

  #operationMarkerAt(trainRunId: string, at: number): OperationMarkerChange | undefined {
    const timeline = this.#operationMarkerTimelines.get(trainRunId);
    if (timeline === undefined) return undefined;
    let effective: OperationMarkerChange | undefined;
    for (const change of timeline) {
      if (change.effectiveAt > at) break;
      effective = change;
    }
    return effective;
  }

  #operationMarkerForTrain(train: PublicTrain, at: number): OperationMarkerChange | undefined {
    const exact = this.#operationMarkerAt(train.id, at);
    const baseTrainRunId = verifiedBaseTrainRunId(train);
    if (baseTrainRunId === undefined) return exact;
    const base = this.#operationMarkerAt(baseTrainRunId, at);
    if (exact === undefined) return base;
    if (base === undefined) return exact;
    return exact.effectiveAt >= base.effectiveAt ? exact : base;
  }

  #recordOperationMarker(
    trainRunId: string,
    operationMarker: PublicOperationMarker | null,
    effectiveAt: number,
  ): boolean {
    const timeline = this.#operationMarkerTimelines.get(trainRunId) ?? [];
    const insertAt = timeline.findIndex((item) => item.effectiveAt > effectiveAt);
    const previous = timeline[(insertAt === -1 ? timeline.length : insertAt) - 1];
    if (
      previous?.effectiveAt === effectiveAt &&
      (previous.operationMarker === null) === (operationMarker === null)
    ) {
      return false;
    }
    const change = Object.freeze({ operationMarker, effectiveAt });
    if (insertAt === -1) timeline.push(change);
    else timeline.splice(insertAt, 0, change);
    this.#operationMarkerTimelines.set(trainRunId, timeline);

    const latest = this.#latestOperationMarkers.get(trainRunId);
    if (latest !== undefined && latest.effectiveAt > effectiveAt) return false;
    this.#latestOperationMarkers.set(trainRunId, change);
    return true;
  }

  #projectOperationMarker(
    train: PublicTrain,
    operationMarker: PublicOperationMarker | null,
  ): PublicTrain {
    if (operationMarker !== null) {
      if (train.operationMarker === PUBLIC_OPERATION_MARKER) return train;
      return Object.freeze({ ...train, operationMarker: PUBLIC_OPERATION_MARKER });
    }
    if (train.operationMarker === undefined) return train;
    const { operationMarker: _operationMarker, ...unmarkedTrain } = train;
    return Object.freeze(unmarkedTrain);
  }

  publish(input: Omit<LiveDelta, "worldId" | "streamId" | "sequence">): LiveDelta {
    if (!Number.isSafeInteger(input.at) || input.at < 0 || input.at < this.#at) {
      throw new RangeError("Livemap-Deltazeit muss eine sichere, nicht fallende Weltsekunde sein.");
    }
    const changed = input.changed.map((train) => {
      if (
        train.operationMarker !== undefined &&
        (train.operationMarker.schemaVersion !== PUBLIC_OPERATION_MARKER_SCHEMA ||
          train.operationMarker.kind !== "public-operator")
      ) {
        throw new TypeError("Livemap-Betriebsmarker hat ein unbekanntes Schema.");
      }
      const effective = this.#operationMarkerForTrain(train, input.at);
      return effective === undefined
        ? train
        : this.#projectOperationMarker(train, effective.operationMarker);
    });
    return this.#emit({ ...input, changed });
  }

  /**
   * Setzt oder entfernt den Eigenbetriebsmarker, ohne eine Position zu erzeugen.
   *
   * Noch nicht materialisierte Zugläufe werden lediglich vorgemerkt. Bereits
   * bekannte Zugläufe erhalten ein neues Delta mit ihrer letzten
   * autoritativen Position und deren unveränderter Sample-Zeit; die
   * Ereigniszeit bleibt als Wirksamkeitsgrenze erhalten. Historische Samples
   * vor dieser Grenze werden nicht nachträglich umgedeutet.
   */
  setOperationMarker(
    trainRunIds: readonly string[],
    operationMarker: PublicOperationMarker | null,
    at: number,
  ): LiveDelta | undefined {
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new RangeError("Markerzeit muss eine sichere, nichtnegative Weltsekunde sein.");
    }
    if (
      operationMarker !== null &&
      (operationMarker.schemaVersion !== PUBLIC_OPERATION_MARKER_SCHEMA ||
        operationMarker.kind !== "public-operator")
    ) {
      throw new TypeError("Livemap-Betriebsmarker hat ein unbekanntes Schema.");
    }
    if (trainRunIds.length === 0) {
      throw new RangeError("Eine Markeraktualisierung braucht mindestens einen Zuglauf.");
    }
    const identifiers = [...new Set(trainRunIds)].sort(compareUtf8);
    if (identifiers.some((id) => id.length === 0)) {
      throw new RangeError("Zuglaufkennungen für Markeraktualisierungen dürfen nicht leer sein.");
    }

    const changed = new Map<string, PublicTrain>();
    for (const id of identifiers) {
      const normalizedMarker = operationMarker === null ? null : PUBLIC_OPERATION_MARKER;
      const changesCurrentProjection = this.#recordOperationMarker(id, normalizedMarker, at);
      if (!changesCurrentProjection || at > this.#at) continue;
      for (const train of this.#trains.values()) {
        if (train.id !== id && verifiedBaseTrainRunId(train) !== id) continue;
        const effective = this.#operationMarkerForTrain(train, this.#at);
        if (effective === undefined) continue;
        const projected = this.#projectOperationMarker(train, effective.operationMarker);
        if (projected !== train) changed.set(projected.id, projected);
      }
    }
    if (changed.size === 0) return undefined;
    return this.#emit({ at: this.#at, changed: [...changed.values()].sort((left, right) => compareUtf8(left.id, right.id)), removed: [] });
  }

  markPublicOperation(trainRunIds: readonly string[], at: number): LiveDelta | undefined {
    return this.setOperationMarker(trainRunIds, PUBLIC_OPERATION_MARKER, at);
  }

  clearOperationMarker(trainRunIds: readonly string[], at: number): LiveDelta | undefined {
    return this.setOperationMarker(trainRunIds, null, at);
  }

  /** Deltas nach einer Client-Sequenz; `undefined`, wenn der Ringpuffer nicht reicht. */
  deltasAfter(sequence: number): readonly LiveDelta[] | undefined {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.#sequence) return undefined;
    if (sequence === this.#sequence) return [];
    const firstAvailable = this.#history[0]?.sequence ?? this.#sequence + 1;
    if (sequence + 1 < firstAvailable) return undefined;
    return this.#history.filter((delta) => delta.sequence > sequence);
  }

  subscribe(listener: DeltaListener): () => void {
    const subscription = Object.freeze({ delta: listener });
    this.#listeners.add(subscription);
    return () => { this.#listeners.delete(subscription); };
  }

  /** Invalidiert alle bestehenden Transporte sofort und genau einmal. */
  invalidate(): void {
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    listeners.forEach((listener) => listener.reset?.());
  }

  /**
   * Verbindet Ringpuffer-Replay und laufenden Fanout ohne zeitliche Lücke.
   *
   * Der Aufruf ist synchron: Zwischen der Bestimmung des Replays und dem
   * Eintragen des Listeners kann kein Publish-Turn laufen. Reicht der
   * Ringpuffer nicht zurück, wird kein Listener eingetragen; der Transport
   * muss genau ein `reset` senden und schließen.
   */
  subscribeAfter(
    cursor: LivemapCursor,
    listener: DeltaListener,
    reset?: ResetListener,
  ): LivemapSubscription {
    if (cursor.streamId !== this.#streamId) {
      return { kind: "reset", unsubscribe: () => undefined };
    }
    const replay = this.deltasAfter(cursor.sequence);
    if (replay === undefined) {
      return { kind: "reset", unsubscribe: () => undefined };
    }

    const subscription = Object.freeze({ delta: listener, ...(reset === undefined ? {} : { reset }) });
    this.#listeners.add(subscription);
    let subscribed = true;
    return {
      kind: "resume",
      replay,
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        this.#listeners.delete(subscription);
      },
    };
  }
}

export interface LivemapRegistryOptions {
  readonly maxFeeds?: number;
  readonly idleTtlMs?: number;
  readonly historyLimit?: number;
  readonly now?: () => number;
  readonly createStreamId?: () => string;
  readonly trainMapProjector?: PublicTrainMapProjector;
  readonly objectStateProjector?: PublicObjectStateProjector;
}

export interface OperationalLivemapRegionSnapshot {
  readonly at: number;
  readonly trains: readonly PublicTrain[];
  readonly operationalRegions: readonly PublicOperationalRegionFrame[];
}

export class LivemapCapacityError extends Error {
  constructor(maxFeeds: number) {
    super(`Livemap-Registry hat ihr Limit von ${maxFeeds} Welten erreicht.`);
    this.name = "LivemapCapacityError";
  }
}

interface RegistryEntry {
  readonly feed: LivemapFeed;
  readonly trainIdsByRegion: Map<string, Set<string>>;
  readonly externalTrainIdsByRegion: Map<string, Set<string>>;
  readonly objectStateIdsByRegion: Map<string, Set<string>>;
  readonly derivedObjectStateIdsByRegion: Map<string, Map<string, Set<string>>>;
  lastAccessMs: number;
  initialized: boolean;
}

/** Registry erzwingt Weltkennung, TTL und ein hartes Speicherlimit. */
export class LivemapRegistry {
  readonly #feeds = new Map<string, RegistryEntry>();
  readonly #operationMarkerTimelines = new Map<
    string,
    Map<string, OperationMarkerChange[]>
  >();
  readonly #maxFeeds: number;
  readonly #idleTtlMs: number;
  readonly #historyLimit: number;
  readonly #now: () => number;
  readonly #createStreamId: () => string;
  readonly #trainMapProjector: PublicTrainMapProjector | undefined;
  readonly #objectStateProjector: PublicObjectStateProjector | undefined;

  constructor(options: LivemapRegistryOptions = {}) {
    this.#maxFeeds = options.maxFeeds ?? 1_000;
    this.#idleTtlMs = options.idleTtlMs ?? 60 * 60 * 1_000;
    this.#historyLimit = options.historyLimit ?? 256;
    this.#now = options.now ?? Date.now;
    this.#createStreamId = options.createStreamId ?? randomStreamId;
    this.#trainMapProjector = options.trainMapProjector;
    this.#objectStateProjector = options.objectStateProjector;
    if (!Number.isSafeInteger(this.#maxFeeds) || this.#maxFeeds <= 0) {
      throw new RangeError("maxFeeds muss eine positive Ganzzahl sein.");
    }
  }

  #projectTrains(worldId: string, trains: readonly PublicTrain[]): readonly PublicTrain[] {
    if (this.#trainMapProjector === undefined) return trains;
    return trains.map((train) => {
      // E31: Die v2-Engine liefert Releasegeometrie und Betriebsposition
      // gemeinsam. Der kumulative v1-Projektor darf diesen Beweis weder
      // entfernen noch auf einen historischen Laufweg umdeuten.
      if (train.operational !== undefined) return train;
      const projected = this.#trainMapProjector!.project(worldId, train);
      if (projected.id !== train.id || projected.positionMm !== train.positionMm) {
        throw new TypeError("Livemap-Kartenprojektor darf Zugidentitaet oder Betriebsposition nicht veraendern.");
      }
      return projected;
    });
  }

  #projectExternalTrains(
    worldId: string,
    trains: readonly PublicExternalTrain[],
  ): readonly PublicExternalTrain[] {
    const project = this.#trainMapProjector?.projectExternal;
    if (project === undefined) return trains;
    return trains.map((train) => {
      const projected = project.call(this.#trainMapProjector, worldId, train);
      if (
        projected.id !== train.id
        || projected.journeyChainId !== train.journeyChainId
        || projected.externalLegId !== train.externalLegId
      ) {
        throw new TypeError("Livemap-Kartenprojektor darf Aussenlaufidentitaeten nicht veraendern.");
      }
      return projected;
    });
  }

  #projectDisruptionStates(
    worldId: string,
    disruption: PublicInfrastructureDisruption,
  ): readonly PublicObjectState[] {
    if (this.#objectStateProjector === undefined) return [];
    const states = this.#objectStateProjector.projectDisruption(worldId, disruption);
    const identifiers = new Set<string>();
    for (const state of states) {
      if (
        state.objectKind !== "track"
        || state.disruptionId !== disruption.disruptionId
        || identifiers.has(state.id)
      ) {
        throw new TypeError("Livemap-Objektzustandsprojektor verletzt Ressourcen- oder Stoerungsbindung.");
      }
      identifiers.add(state.id);
    }
    return states;
  }

  get size(): number {
    return this.#feeds.size;
  }

  #pruneExpired(now: number): void {
    for (const [worldId, entry] of this.#feeds) {
      if (entry.feed.subscriberCount === 0 && now - entry.lastAccessMs >= this.#idleTtlMs) {
        this.#feeds.delete(worldId);
      }
    }
  }

  #recordOperationMarkers(
    worldId: string,
    trainRunIds: readonly string[],
    operationMarker: PublicOperationMarker | null,
    at: number,
  ): void {
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new RangeError("Markerzeit muss eine sichere, nichtnegative Weltsekunde sein.");
    }
    if (
      operationMarker !== null &&
      (operationMarker.schemaVersion !== PUBLIC_OPERATION_MARKER_SCHEMA ||
        operationMarker.kind !== "public-operator")
    ) {
      throw new TypeError("Livemap-Betriebsmarker hat ein unbekanntes Schema.");
    }
    if (trainRunIds.length === 0) {
      throw new RangeError("Eine Markeraktualisierung braucht mindestens einen Zuglauf.");
    }
    const identifiers = [...new Set(trainRunIds)].sort(compareUtf8);
    if (identifiers.some((id) => id.length === 0)) {
      throw new RangeError("Zuglaufkennungen fuer Markeraktualisierungen duerfen nicht leer sein.");
    }
    const byTrain =
    this.#operationMarkerTimelines.get(worldId) ??
      new Map<string, OperationMarkerChange[]>();
    for (const trainRunId of identifiers) {
      const timeline = byTrain.get(trainRunId) ?? [];
      const insertAt = timeline.findIndex((item) => item.effectiveAt > at);
      const previous = timeline[(insertAt === -1 ? timeline.length : insertAt) - 1];
      if (
        previous?.effectiveAt === at &&
        (previous.operationMarker === null) === (operationMarker === null)
      ) {
        continue;
      }
      const change = Object.freeze({
        operationMarker: operationMarker === null ? null : PUBLIC_OPERATION_MARKER,
        effectiveAt: at,
      });
      if (insertAt === -1) timeline.push(change);
      else timeline.splice(insertAt, 0, change);
      byTrain.set(trainRunId, timeline);
    }
    this.#operationMarkerTimelines.set(worldId, byTrain);
  }

  #replayOperationMarkers(worldId: string, feed: LivemapFeed): void {
    const byTrain = this.#operationMarkerTimelines.get(worldId);
    if (byTrain === undefined) return;
    for (const trainRunId of [...byTrain.keys()].sort(compareUtf8)) {
      for (const change of byTrain.get(trainRunId) ?? []) {
        feed.setOperationMarker(
          [trainRunId],
          change.operationMarker,
          change.effectiveAt,
        );
      }
    }
  }

  #entryForWorld(worldId: string): RegistryEntry {
    const now = this.#now();
    this.#pruneExpired(now);
    const existing = this.#feeds.get(worldId);
    if (existing !== undefined) {
      existing.lastAccessMs = now;
      return existing;
    }
    if (this.#feeds.size >= this.#maxFeeds) {
      const evictable = [...this.#feeds.entries()]
        .filter(([, entry]) => entry.feed.subscriberCount === 0)
        .sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs)[0];
      if (evictable === undefined) throw new LivemapCapacityError(this.#maxFeeds);
      this.#feeds.delete(evictable[0]);
    }
    const feed = new LivemapFeed(
      worldId,
      this.#historyLimit,
      this.#now,
      this.#createStreamId(),
    );
    this.#replayOperationMarkers(worldId, feed);
    const entry = {
      feed,
      trainIdsByRegion: new Map<string, Set<string>>(),
      externalTrainIdsByRegion: new Map<string, Set<string>>(),
      objectStateIdsByRegion: new Map<string, Set<string>>(),
      derivedObjectStateIdsByRegion: new Map<string, Map<string, Set<string>>>(),
      lastAccessMs: now,
      initialized: false,
    };
    this.#feeds.set(worldId, entry);
    return entry;
  }

  forWorld(worldId: string): LivemapFeed {
    return this.#entryForWorld(worldId).feed;
  }

  /**
   * Wahr erst nach einem autoritativen Rust-Initialsnapshot.
   *
   * Das blosse Anlegen eines Feeds oder das Vormerken von Betriebsmarkern
   * schaltet eine Welt ausdruecklich nicht frei.
   */
  isInitialized(worldId: string): boolean {
    return this.#feeds.get(worldId)?.initialized ?? false;
  }

  /**
   * Liefert genau den bereits initialisierten Feed in einem synchronen Schritt.
   * Abgelaufene Eintraege werden entfernt; ein leerer Ersatzfeed entsteht nie.
   */
  initializedWorld(worldId: string): LivemapFeed | undefined {
    const now = this.#now();
    this.#pruneExpired(now);
    const entry = this.#feeds.get(worldId);
    if (entry === undefined || !entry.initialized) return undefined;
    entry.lastAccessMs = now;
    return entry.feed;
  }

  /** Initialisiert den oeffentlichen Feed atomar aus einem Rust-Snapshot. */
  initializeWorld(
    worldId: string,
    snapshot: Omit<LiveSnapshot, "worldId" | "streamId" | "sequence">,
  ): LiveDelta {
    return this.initializeRegion(worldId, "__single_region__", snapshot);
  }

  /**
   * Initialisiert oder restauriert genau eine Region.
   *
   * Nur frueher dieser Region zugeordnete, im neuen Snapshot fehlende Zuege
   * werden entfernt. Zuege anderer bereits restaurierter Regionen bleiben
   * erhalten.
   */
  initializeRegion(
    worldId: string,
    regionId: string,
    snapshot: Omit<LiveSnapshot, "worldId" | "streamId" | "sequence">,
  ): LiveDelta {
    if (regionId.length === 0 || regionId.length > 200) {
      throw new RangeError("regionId muss 1 bis 200 Zeichen besitzen.");
    }
    const entry = this.#entryForWorld(worldId);
    const operationalRegions = snapshot.operationalRegions;
    if (
      operationalRegions !== undefined &&
      (operationalRegions.length > 1 || operationalRegions.some((frame) => frame.regionId !== regionId))
    ) {
      throw new RangeError("Ein Regionssnapshot darf nur seinen eigenen operativen Regionsframe enthalten.");
    }
    const projectedTrains = this.#projectTrains(worldId, snapshot.trains);
    const nextIds = new Set(projectedTrains.map((train) => train.id));
    if (nextIds.size !== projectedTrains.length) {
      throw new RangeError("Ein Regionssnapshot darf keine doppelten Zuglaufkennungen besitzen.");
    }
    const previousIds = entry.trainIdsByRegion.get(regionId) ?? new Set<string>();
    const externalTrains = this.#projectExternalTrains(worldId, snapshot.externalTrains ?? []);
    const nextExternalIds = new Set(externalTrains.map((train) => train.id));
    if (nextExternalIds.size !== externalTrains.length) {
      throw new RangeError("Ein Regionssnapshot darf keine doppelten Aussenlaufkennungen besitzen.");
    }
    const previousExternalIds = entry.externalTrainIdsByRegion.get(regionId) ?? new Set<string>();
    const derivedByDisruption = new Map<string, Set<string>>();
    const projectedObjectStates = (snapshot.disruptions ?? []).flatMap((disruption) => {
      if (derivedByDisruption.has(disruption.disruptionId)) {
        throw new RangeError("Ein Regionssnapshot darf keine doppelten Stoerungskennungen besitzen.");
      }
      const states = this.#projectDisruptionStates(worldId, disruption);
      derivedByDisruption.set(disruption.disruptionId, new Set(states.map((state) => state.id)));
      return states;
    });
    const objectStates = [...(snapshot.objectStates ?? []), ...projectedObjectStates];
    const nextObjectStateIds = new Set(objectStates.map((state) => state.id));
    if (nextObjectStateIds.size !== objectStates.length) {
      throw new RangeError("Ein Regionssnapshot darf keine doppelten Infrastrukturzustandskennungen besitzen.");
    }
    const previousObjectStateIds = entry.objectStateIdsByRegion.get(regionId) ?? new Set<string>();
    const ownedElsewhere = (trainRunId: string) =>
      [...entry.trainIdsByRegion].some(
        ([otherRegionId, identifiers]) =>
          otherRegionId !== regionId && identifiers.has(trainRunId),
      );
    const objectStateOwnedElsewhere = (identifier: string) =>
      [...entry.objectStateIdsByRegion].some(
        ([otherRegionId, identifiers]) =>
          otherRegionId !== regionId && identifiers.has(identifier),
      );
    const removed = [...previousIds]
      .filter((trainRunId) => !nextIds.has(trainRunId) && !ownedElsewhere(trainRunId))
      .sort(compareUtf8);
    const removedExternalTrainIds = [...previousExternalIds]
      .filter((trainRunId) => !nextExternalIds.has(trainRunId))
      .sort(compareUtf8);
    const removedObjectStateIds = [...previousObjectStateIds]
      .filter((identifier) => !nextObjectStateIds.has(identifier) && !objectStateOwnedElsewhere(identifier))
      .sort(compareUtf8);
    const delta = entry.feed.publish({
      at: snapshot.at,
      changed: projectedTrains,
      removed,
      changedExternalTrains: externalTrains,
      removedExternalTrainIds,
      changedDisruptions: snapshot.disruptions ?? [],
      removedDisruptionIds: [],
      changedObjectStates: objectStates,
      removedObjectStateIds,
      changedOperationalRegions: operationalRegions ?? [],
      removedOperationalRegionIds:
        operationalRegions !== undefined && operationalRegions.length === 0 ? [regionId] : [],
    });
    for (const trainRunId of nextIds) {
      for (const [otherRegionId, identifiers] of entry.trainIdsByRegion) {
        if (otherRegionId !== regionId) identifiers.delete(trainRunId);
      }
    }
    for (const identifier of nextObjectStateIds) {
      for (const [otherRegionId, identifiers] of entry.objectStateIdsByRegion) {
        if (otherRegionId !== regionId) identifiers.delete(identifier);
      }
    }
    entry.trainIdsByRegion.set(regionId, nextIds);
    entry.externalTrainIdsByRegion.set(regionId, nextExternalIds);
    entry.objectStateIdsByRegion.set(regionId, nextObjectStateIds);
    entry.derivedObjectStateIdsByRegion.set(regionId, derivedByDisruption);
    entry.initialized = true;
    return delta;
  }

  /**
   * Publiziert ein Regionsdelta nur auf einen bereits initialisierten Feed.
   * Ein fehlendes Ergebnis signalisiert, dass ein Vollrestore erforderlich ist.
   */
  publishRegionDelta(
    worldId: string,
    regionId: string,
    input: Omit<LiveDelta, "worldId" | "streamId" | "sequence">,
  ): LiveDelta | undefined {
    const feed = this.initializedWorld(worldId);
    if (feed === undefined) return undefined;
    const entry = this.#feeds.get(worldId);
    if (entry === undefined) return undefined;
    if (
      (input.changedOperationalRegions ?? []).some((frame) => frame.regionId !== regionId) ||
      (input.removedOperationalRegionIds ?? []).some((identifier) => identifier !== regionId)
    ) {
      throw new RangeError("Ein Regionsdelta darf keinen fremden operativen Regionsframe veraendern.");
    }
    const identifiers = entry.trainIdsByRegion.get(regionId) ?? new Set<string>();
    const externalIdentifiers = entry.externalTrainIdsByRegion.get(regionId) ?? new Set<string>();
    const objectStateIdentifiers = entry.objectStateIdsByRegion.get(regionId) ?? new Set<string>();
    const previousDerived = entry.derivedObjectStateIdsByRegion.get(regionId) ?? new Map<string, Set<string>>();
    const nextDerived = new Map([...previousDerived].map(([disruptionId, identifiers]) => [disruptionId, new Set(identifiers)]));
    const ownedElsewhere = (trainRunId: string) =>
      [...entry.trainIdsByRegion].some(
        ([otherRegionId, otherIdentifiers]) =>
          otherRegionId !== regionId && otherIdentifiers.has(trainRunId),
      );
    const objectStateOwnedElsewhere = (identifier: string) =>
      [...entry.objectStateIdsByRegion].some(
        ([otherRegionId, otherIdentifiers]) =>
          otherRegionId !== regionId && otherIdentifiers.has(identifier),
      );
    const projectedChanged = this.#projectTrains(worldId, input.changed);
    const projectedExternalChanged = this.#projectExternalTrains(
      worldId,
      input.changedExternalTrains ?? [],
    );
    const changedDisruptionIds = new Set<string>();
    const projectedObjectStates = (input.changedDisruptions ?? []).flatMap((disruption) => {
      if (changedDisruptionIds.has(disruption.disruptionId)) {
        throw new RangeError("Ein Regionsdelta darf keine doppelten Stoerungskennungen besitzen.");
      }
      changedDisruptionIds.add(disruption.disruptionId);
      const states = this.#projectDisruptionStates(worldId, disruption);
      const nextIdentifiers = new Set(states.map((state) => state.id));
      nextDerived.set(disruption.disruptionId, nextIdentifiers);
      return states;
    });
    const derivedRemovedObjectStateIds = new Set<string>();
    for (const disruption of input.changedDisruptions ?? []) {
      const nextIdentifiers = nextDerived.get(disruption.disruptionId) ?? new Set<string>();
      for (const identifier of previousDerived.get(disruption.disruptionId) ?? []) {
        if (!nextIdentifiers.has(identifier)) derivedRemovedObjectStateIds.add(identifier);
      }
    }
    for (const disruptionId of input.removedDisruptionIds ?? []) {
      for (const identifier of previousDerived.get(disruptionId) ?? []) derivedRemovedObjectStateIds.add(identifier);
      nextDerived.delete(disruptionId);
    }
    const changedObjectStates = [...(input.changedObjectStates ?? []), ...projectedObjectStates];
    const requestedRemovedObjectStateIds = [...new Set([...(input.removedObjectStateIds ?? []), ...derivedRemovedObjectStateIds])];
    const removed = input.removed.filter((trainRunId) => !ownedElsewhere(trainRunId));
    const removedObjectStateIds = requestedRemovedObjectStateIds
      .filter((identifier) => !objectStateOwnedElsewhere(identifier));
    const delta = feed.publish({
      ...input,
      changed: projectedChanged,
      changedExternalTrains: projectedExternalChanged,
      changedObjectStates,
      removed,
      removedObjectStateIds,
    });
    for (const train of projectedChanged) {
      for (const [otherRegionId, otherIdentifiers] of entry.trainIdsByRegion) {
        if (otherRegionId !== regionId) otherIdentifiers.delete(train.id);
      }
      identifiers.add(train.id);
    }
    input.removed.forEach((trainRunId) => identifiers.delete(trainRunId));
    for (const train of projectedExternalChanged) externalIdentifiers.add(train.id);
    for (const trainRunId of input.removedExternalTrainIds ?? []) externalIdentifiers.delete(trainRunId);
    for (const state of changedObjectStates) objectStateIdentifiers.add(state.id);
    for (const state of changedObjectStates) {
      for (const [otherRegionId, identifiers] of entry.objectStateIdsByRegion) {
        if (otherRegionId !== regionId) identifiers.delete(state.id);
      }
    }
    for (const identifier of requestedRemovedObjectStateIds) objectStateIdentifiers.delete(identifier);
    entry.trainIdsByRegion.set(regionId, identifiers);
    entry.externalTrainIdsByRegion.set(regionId, externalIdentifiers);
    entry.objectStateIdsByRegion.set(regionId, objectStateIdentifiers);
    entry.derivedObjectStateIdsByRegion.set(regionId, nextDerived);
    return delta;
  }

  /**
   * Uebernimmt einen vollstaendigen nativen v2-Regionssnapshot. Bei jedem
   * neuen Regionscommit werden alle v2-Zuege derselben Region zusammen mit
   * dem Frame in genau einem `#emit` publiziert; alte per-train Commits sind
   * damit auch in einem spaeter gelesenen Vollsnapshot ausgeschlossen.
   */
  publishOperationalRegionSnapshot(
    worldId: string,
    regionId: string,
    snapshot: OperationalLivemapRegionSnapshot,
  ): LiveDelta | undefined {
    if (
      snapshot.operationalRegions.length !== 1 ||
      snapshot.operationalRegions[0]?.regionId !== regionId
    ) {
      throw new RangeError("Operativer Regionssnapshot braucht genau seinen committed Regionsframe.");
    }
    if (snapshot.trains.some((train) =>
      train.operational?.regionId !== regionId || train.mapPosition === undefined
    )) {
      throw new RangeError("Operativer Regionssnapshot darf nur exakt georeferenzierte Zuege seiner Region enthalten.");
    }
    const feed = this.initializedWorld(worldId);
    if (feed === undefined) return undefined;
    const entry = this.#feeds.get(worldId);
    if (entry === undefined) return undefined;
    const previousFrame = feed.snapshot().operationalRegions?.find((frame) => frame.regionId === regionId);
    const nextFrame = snapshot.operationalRegions[0]!;
    if (
      previousFrame !== undefined && (
        nextFrame.commitSequence !== previousFrame.commitSequence + 1 ||
        nextFrame.simulationTimeMs < previousFrame.simulationTimeMs
      )
    ) {
      throw new RangeError("Operative Regionscommits muessen lueckenlos und zeitlich monoton sein.");
    }
    const previousIds = entry.trainIdsByRegion.get(regionId) ?? new Set<string>();
    const previousTrains = new Map(feed.snapshot().trains.map((train) => [train.id, train] as const));
    const nextIds = new Set(snapshot.trains.map((train) => train.id));
    if (nextIds.size !== snapshot.trains.length) {
      throw new RangeError("Operativer Regionssnapshot darf keine doppelten Zugkennungen besitzen.");
    }
    const changed = snapshot.trains.filter((train) => {
      const previous = previousTrains.get(train.id);
      return previous === undefined || !sameTrainProjection(previous, train);
    });
    const removed = [...previousIds]
      .filter((trainId) => !nextIds.has(trainId))
      .sort(compareUtf8);
    return this.publishRegionDelta(worldId, regionId, {
      at: snapshot.at,
      changed,
      removed,
      changedOperationalRegions: snapshot.operationalRegions,
      removedOperationalRegionIds: [],
    });
  }

  /** Sperrt die oeffentlichen Routen nach einem fehlgeschlagenen Fanout. */
  markUnavailable(worldId: string): void {
    const entry = this.#feeds.get(worldId);
    if (entry === undefined) return;
    entry.initialized = false;
    entry.feed.invalidate();
  }

  /**
   * Entfernt eine abgeschlossene Welt samt prozesslokaler Markertimeline.
   * Wiederholte Reaper-/Archivaufrufe bleiben absichtlich wirkungslos.
   */
  releaseWorld(worldId: string): void {
    this.#feeds.delete(worldId);
    this.#operationMarkerTimelines.delete(worldId);
  }

  peekWorld(worldId: string): LivemapFeed | undefined {
    const entry = this.#feeds.get(worldId);
    if (entry !== undefined) entry.lastAccessMs = this.#now();
    return entry?.feed;
  }

  markPublicOperation(
    worldId: string,
    trainRunIds: readonly string[],
    at: number,
  ): LiveDelta | undefined {
    return this.setOperationMarker(worldId, trainRunIds, PUBLIC_OPERATION_MARKER, at);
  }

  setOperationMarker(
    worldId: string,
    trainRunIds: readonly string[],
    operationMarker: PublicOperationMarker | null,
    at: number,
  ): LiveDelta | undefined {
    this.#recordOperationMarkers(worldId, trainRunIds, operationMarker, at);
    return this.forWorld(worldId).setOperationMarker(trainRunIds, operationMarker, at);
  }

  clearOperationMarker(
    worldId: string,
    trainRunIds: readonly string[],
    at: number,
  ): LiveDelta | undefined {
    return this.setOperationMarker(worldId, trainRunIds, null, at);
  }

  freshness(
    maximumAgeMs: number,
    now = this.#now(),
    isExpectedFresh: (worldId: string) => boolean = () => true,
  ): { readonly feedCount: number; readonly staleFeeds: number } {
    let feedCount = 0;
    let staleFeeds = 0;
    for (const [worldId, { feed }] of this.#feeds) {
      if (!isExpectedFresh(worldId)) continue;
      feedCount += 1;
      if (feed.lastPublishedAtMs === undefined || now - feed.lastPublishedAtMs > maximumAgeMs) {
        staleFeeds += 1;
      }
    }
    return { feedCount, staleFeeds };
  }

  expectedFreshness(
    expectedWorldIds: readonly string[],
    maximumAgeMs: number,
    now = this.#now(),
  ): { readonly feedCount: number; readonly staleFeeds: number; readonly missingFeeds: number } {
    const expected = new Set(expectedWorldIds);
    let feedCount = 0;
    let staleFeeds = 0;
    let missingFeeds = 0;
    for (const worldId of expected) {
      const entry = this.#feeds.get(worldId);
      if (entry === undefined || !entry.initialized) {
        missingFeeds += 1;
        continue;
      }
      feedCount += 1;
      if (
        entry.feed.lastPublishedAtMs === undefined
        || now - entry.feed.lastPublishedAtMs > maximumAgeMs
      ) {
        staleFeeds += 1;
      }
    }
    return { feedCount, staleFeeds, missingFeeds };
  }
}

export function createLivemapHealthCheck(
  registry: LivemapRegistry,
  maximumAgeMs = 60_000,
  now: () => number = Date.now,
  isExpectedFresh: (worldId: string, nowMs: number) => boolean = () => true,
  expectedFreshWorldIds?: (nowMs: number) => readonly string[],
): HealthCheck {
  return {
    name: "livemap-freshness",
    async check() {
      const nowMs = now();
      const snapshots = expectedFreshWorldIds === undefined
        ? { ...registry.freshness(
            maximumAgeMs,
            nowMs,
            (worldId) => isExpectedFresh(worldId, nowMs),
          ), missingFeeds: 0 }
        : registry.expectedFreshness(
            expectedFreshWorldIds(nowMs),
            maximumAgeMs,
            nowMs,
          );
      if (snapshots.missingFeeds > 0) {
        return {
          status: "down",
          code: "livemap_missing",
          detail: `${snapshots.missingFeeds}/${snapshots.feedCount + snapshots.missingFeeds} erwartete Feeds fehlen`,
        };
      }
      if (snapshots.staleFeeds > 0) {
        return {
          status: "degraded",
          code: "livemap_stale",
          detail: `${snapshots.staleFeeds}/${snapshots.feedCount} Feeds älter als ${maximumAgeMs} ms`,
        };
      }
      return {
        status: "ok",
        code: snapshots.feedCount === 0 ? "livemap_idle" : "livemap_fresh",
      };
    },
  };
}
