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

export interface PublicOperationMarker {
  readonly schemaVersion: typeof PUBLIC_OPERATION_MARKER_SCHEMA;
  readonly kind: "public-operator";
}

export const PUBLIC_OPERATION_MARKER: PublicOperationMarker = Object.freeze({
  schemaVersion: PUBLIC_OPERATION_MARKER_SCHEMA,
  kind: "public-operator",
});

export interface PublicTrain {
  readonly id: string;
  readonly operator: string;
  readonly trainNumber: string;
  readonly category: string;
  readonly positionMm: number;
  readonly speedMmPerSecond: number;
  readonly delaySeconds: number;
  readonly nextOperatingPoint: string;
  readonly status: string;
  readonly operationMarker?: PublicOperationMarker;
}

export interface LiveSnapshot {
  readonly worldId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly at: number;
  readonly trains: readonly PublicTrain[];
}

export interface LiveDelta {
  readonly worldId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly at: number;
  readonly changed: readonly PublicTrain[];
  readonly removed: readonly string[];
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
    };
  }

  #emit(input: Omit<LiveDelta, "worldId" | "streamId" | "sequence">): LiveDelta {
    input.changed.forEach((train) => this.#trains.set(train.id, train));
    input.removed.forEach((id) => this.#trains.delete(id));
    this.#sequence += 1;
    this.#at = input.at;
    this.#lastPublishedAtMs = this.#now();
    const delta: LiveDelta = {
      ...input,
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
      const effective = this.#operationMarkerAt(train.id, input.at);
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

    const changed: PublicTrain[] = [];
    for (const id of identifiers) {
      const normalizedMarker = operationMarker === null ? null : PUBLIC_OPERATION_MARKER;
      const changesCurrentProjection = this.#recordOperationMarker(id, normalizedMarker, at);
      const train = this.#trains.get(id);
      if (train === undefined || !changesCurrentProjection || at > this.#at) continue;
      const projected = this.#projectOperationMarker(train, normalizedMarker);
      if (projected !== train) changed.push(projected);
    }
    if (changed.length === 0) return undefined;
    return this.#emit({ at: this.#at, changed, removed: [] });
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

  constructor(options: LivemapRegistryOptions = {}) {
    this.#maxFeeds = options.maxFeeds ?? 1_000;
    this.#idleTtlMs = options.idleTtlMs ?? 60 * 60 * 1_000;
    this.#historyLimit = options.historyLimit ?? 256;
    this.#now = options.now ?? Date.now;
    this.#createStreamId = options.createStreamId ?? randomStreamId;
    if (!Number.isSafeInteger(this.#maxFeeds) || this.#maxFeeds <= 0) {
      throw new RangeError("maxFeeds muss eine positive Ganzzahl sein.");
    }
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
    const nextIds = new Set(snapshot.trains.map((train) => train.id));
    if (nextIds.size !== snapshot.trains.length) {
      throw new RangeError("Ein Regionssnapshot darf keine doppelten Zuglaufkennungen besitzen.");
    }
    const previousIds = entry.trainIdsByRegion.get(regionId) ?? new Set<string>();
    const ownedElsewhere = (trainRunId: string) =>
      [...entry.trainIdsByRegion].some(
        ([otherRegionId, identifiers]) =>
          otherRegionId !== regionId && identifiers.has(trainRunId),
      );
    const removed = [...previousIds]
      .filter((trainRunId) => !nextIds.has(trainRunId) && !ownedElsewhere(trainRunId))
      .sort(compareUtf8);
    const delta = entry.feed.publish({
      at: snapshot.at,
      changed: snapshot.trains,
      removed,
    });
    for (const trainRunId of nextIds) {
      for (const [otherRegionId, identifiers] of entry.trainIdsByRegion) {
        if (otherRegionId !== regionId) identifiers.delete(trainRunId);
      }
    }
    entry.trainIdsByRegion.set(regionId, nextIds);
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
    const ownedElsewhere = (trainRunId: string) =>
      [...entry.trainIdsByRegion].some(
        ([otherRegionId, otherIdentifiers]) =>
          otherRegionId !== regionId && otherIdentifiers.has(trainRunId),
      );
    const removed = input.removed.filter((trainRunId) => !ownedElsewhere(trainRunId));
    const delta = feed.publish({ ...input, removed });
    for (const train of input.changed) {
      for (const [otherRegionId, otherIdentifiers] of entry.trainIdsByRegion) {
        if (otherRegionId !== regionId) otherIdentifiers.delete(train.id);
      }
      identifiers.add(train.id);
    }
    input.removed.forEach((trainRunId) => identifiers.delete(trainRunId));
    entry.trainIdsByRegion.set(regionId, identifiers);
    return delta;
  }

  /** Sperrt die oeffentlichen Routen nach einem fehlgeschlagenen Fanout. */
  markUnavailable(worldId: string): void {
    const entry = this.#feeds.get(worldId);
    if (entry !== undefined) entry.initialized = false;
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
  ): { readonly feedCount: number; readonly staleFeeds: number } {
    let staleFeeds = 0;
    for (const { feed } of this.#feeds.values()) {
      if (feed.lastPublishedAtMs === undefined || now - feed.lastPublishedAtMs > maximumAgeMs) {
        staleFeeds += 1;
      }
    }
    return { feedCount: this.#feeds.size, staleFeeds };
  }
}

export function createLivemapHealthCheck(
  registry: LivemapRegistry,
  maximumAgeMs = 60_000,
  now: () => number = Date.now,
): HealthCheck {
  return {
    name: "livemap-freshness",
    async check() {
      const snapshots = registry.freshness(maximumAgeMs, now());
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
