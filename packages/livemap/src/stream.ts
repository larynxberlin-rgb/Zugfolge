import type { HealthCheck } from "@zugfolge/health";

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
}

export interface LiveSnapshot {
  readonly worldId: string;
  readonly sequence: number;
  readonly at: number;
  readonly trains: readonly PublicTrain[];
}

export interface LiveDelta {
  readonly worldId: string;
  readonly sequence: number;
  readonly at: number;
  readonly changed: readonly PublicTrain[];
  readonly removed: readonly string[];
}

export type DeltaListener = (delta: LiveDelta) => void;

/** Weltisolierter, begrenzt gepufferter In-Process-Fanout. */
export class LivemapFeed {
  readonly #worldId: string;
  readonly #historyLimit: number;
  readonly #now: () => number;
  #sequence = 0;
  #at = 0;
  #lastPublishedAtMs: number | undefined;
  readonly #trains = new Map<string, PublicTrain>();
  readonly #listeners = new Set<DeltaListener>();
  readonly #history: LiveDelta[] = [];

  constructor(worldId: string, historyLimit = 256, now: () => number = Date.now) {
    this.#worldId = worldId;
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
      sequence: this.#sequence,
      at: this.#at,
      trains: [...this.#trains.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  publish(input: Omit<LiveDelta, "worldId" | "sequence">): LiveDelta {
    input.changed.forEach((train) => this.#trains.set(train.id, train));
    input.removed.forEach((id) => this.#trains.delete(id));
    this.#sequence += 1;
    this.#at = input.at;
    this.#lastPublishedAtMs = this.#now();
    const delta: LiveDelta = { ...input, worldId: this.#worldId, sequence: this.#sequence };
    this.#history.push(delta);
    if (this.#history.length > this.#historyLimit) this.#history.shift();
    this.#listeners.forEach((listener) => listener(delta));
    return delta;
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
}

export interface LivemapRegistryOptions {
  readonly maxFeeds?: number;
  readonly idleTtlMs?: number;
  readonly historyLimit?: number;
  readonly now?: () => number;
}

export class LivemapCapacityError extends Error {
  constructor(maxFeeds: number) {
    super(`Livemap-Registry hat ihr Limit von ${maxFeeds} Welten erreicht.`);
    this.name = "LivemapCapacityError";
  }
}

interface RegistryEntry {
  readonly feed: LivemapFeed;
  lastAccessMs: number;
}

/** Registry erzwingt Weltkennung, TTL und ein hartes Speicherlimit. */
export class LivemapRegistry {
  readonly #feeds = new Map<string, RegistryEntry>();
  readonly #maxFeeds: number;
  readonly #idleTtlMs: number;
  readonly #historyLimit: number;
  readonly #now: () => number;

  constructor(options: LivemapRegistryOptions = {}) {
    this.#maxFeeds = options.maxFeeds ?? 1_000;
    this.#idleTtlMs = options.idleTtlMs ?? 60 * 60 * 1_000;
    this.#historyLimit = options.historyLimit ?? 256;
    this.#now = options.now ?? Date.now;
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

  forWorld(worldId: string): LivemapFeed {
    const now = this.#now();
    this.#pruneExpired(now);
    const existing = this.#feeds.get(worldId);
    if (existing !== undefined) {
      existing.lastAccessMs = now;
      return existing.feed;
    }
    if (this.#feeds.size >= this.#maxFeeds) {
      const evictable = [...this.#feeds.entries()]
        .filter(([, entry]) => entry.feed.subscriberCount === 0)
        .sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs)[0];
      if (evictable === undefined) throw new LivemapCapacityError(this.#maxFeeds);
      this.#feeds.delete(evictable[0]);
    }
    const feed = new LivemapFeed(worldId, this.#historyLimit, this.#now);
    this.#feeds.set(worldId, { feed, lastAccessMs: now });
    return feed;
  }

  peekWorld(worldId: string): LivemapFeed | undefined {
    const entry = this.#feeds.get(worldId);
    if (entry !== undefined) entry.lastAccessMs = this.#now();
    return entry?.feed;
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
