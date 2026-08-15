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

export type PublicMapEstimateMethod =
  | "topological-track"
  | "route-corridor"
  | "anchor-hold";

/**
 * Ausschliesslich visuelle, releasegebundene Lageableitung. Sie ist keine
 * Gleisbelegung und darf nie als Fahrweg- oder Konfliktnachweis verwendet
 * werden.
 */
export interface PublicMapEstimate {
  readonly infrastructureReleaseId: string;
  readonly resourceId: string;
  readonly method: PublicMapEstimateMethod;
  readonly displayPathId: string;
  readonly displayOffsetMm: number;
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  readonly bearingMilliDegrees?: number;
  readonly uncertaintyMm: number;
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
  readonly delaySeconds: number;
  readonly nextOperatingPoint: string;
  readonly status: string;
  readonly mapPosition?: PublicMapPosition;
  readonly mapEstimate?: PublicMapEstimate;
  readonly operationMarker?: PublicOperationMarker;
  readonly disruption?: PublicDisruptionMarker;
}

/**
 * Reine, synchrone Releaseprojektion an der Fanout-Grenze. Sie darf entweder
 * eine nachgewiesene `mapPosition` oder eine explizite `mapEstimate`
 * ergaenzen. Beide Darstellungen sind gegenseitig exklusiv.
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

  const estimate = train.mapEstimate;
  if (position !== undefined && estimate !== undefined) {
    throw new RangeError(`Zug '${train.id}' darf nicht zugleich bestaetigte und geschaetzte Kartenlage besitzen.`);
  }
  if (estimate === undefined) return;
  if (
    estimate.infrastructureReleaseId.length === 0 ||
    estimate.resourceId.length === 0 ||
    estimate.displayPathId.length === 0 ||
    !(["topological-track", "route-corridor", "anchor-hold"] as const).includes(estimate.method) ||
    !integer(estimate.displayOffsetMm) || estimate.displayOffsetMm < 0 ||
    !integer(estimate.uncertaintyMm) || estimate.uncertaintyMm < 0 ||
    !integer(estimate.latitudeE7) || estimate.latitudeE7 < -900_000_000 || estimate.latitudeE7 > 900_000_000 ||
    !integer(estimate.longitudeE7) || estimate.longitudeE7 < -1_800_000_000 || estimate.longitudeE7 > 1_800_000_000 ||
    (estimate.bearingMilliDegrees !== undefined && (
      !integer(estimate.bearingMilliDegrees) ||
      estimate.bearingMilliDegrees < 0 ||
      estimate.bearingMilliDegrees >= 360_000
    ))
  ) {
    throw new RangeError(`Zug '${train.id}' besitzt keine gueltige ganzzahlige Kartenschaetzung.`);
  }
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
}

export type DeltaListener = (delta: LiveDelta) => void;

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
  readonly #operationMarkerTimelines = new Map<string, OperationMarkerChange[]>();
  readonly #latestOperationMarkers = new Map<string, OperationMarkerChange>();
  readonly #listeners = new Set<DeltaListener>();
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
    };
  }

  #emit(input: Omit<LiveDelta, "worldId" | "streamId" | "sequence">): LiveDelta {
    input.changed.forEach(validateMapProjection);
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
      worldId: this.#worldId,
      streamId: this.#streamId,
      sequence: this.#sequence,
    };
    this.#history.push(delta);
    if (this.#history.length > this.#historyLimit) this.#history.shift();
    this.#listeners.forEach((listener) => listener(delta));
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
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Verbindet Ringpuffer-Replay und laufenden Fanout ohne zeitliche Lücke.
   *
   * Der Aufruf ist synchron: Zwischen der Bestimmung des Replays und dem
   * Eintragen des Listeners kann kein Publish-Turn laufen. Reicht der
   * Ringpuffer nicht zurück, wird kein Listener eingetragen; der Transport
   * muss genau ein `reset` senden und schließen.
   */
  subscribeAfter(cursor: LivemapCursor, listener: DeltaListener): LivemapSubscription {
    if (cursor.streamId !== this.#streamId) {
      return { kind: "reset", unsubscribe: () => undefined };
    }
    const replay = this.deltasAfter(cursor.sequence);
    if (replay === undefined) {
      return { kind: "reset", unsubscribe: () => undefined };
    }

    this.#listeners.add(listener);
    let subscribed = true;
    return {
      kind: "resume",
      replay,
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        this.#listeners.delete(listener);
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

  /** Sperrt die oeffentlichen Routen nach einem fehlgeschlagenen Fanout. */
  markUnavailable(worldId: string): void {
    const entry = this.#feeds.get(worldId);
    if (entry !== undefined) entry.initialized = false;
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
}

export function createLivemapHealthCheck(
  registry: LivemapRegistry,
  maximumAgeMs = 60_000,
  now: () => number = Date.now,
  isExpectedFresh: (worldId: string, nowMs: number) => boolean = () => true,
): HealthCheck {
  return {
    name: "livemap-freshness",
    async check() {
      const nowMs = now();
      const snapshots = registry.freshness(
        maximumAgeMs,
        nowMs,
        (worldId) => isExpectedFresh(worldId, nowMs),
      );
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
