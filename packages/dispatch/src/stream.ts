import type { OperationsDecision } from "./projection.js";

export interface OperationsDelta {
  readonly worldId: string;
  readonly operatorId: string;
  readonly sequence: number;
  readonly decision: OperationsDecision;
}

export class OperationsFeed {
  readonly #history: OperationsDelta[] = [];
  readonly #subscribers = new Set<(event: OperationsDelta) => void>();
  readonly #historyLimit: number;

  constructor(historyLimit = 512) {
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new RangeError("Stream-Historie ist ungültig.");
    this.#historyLimit = historyLimit;
  }

  publish(event: OperationsDelta): void {
    const previous = this.#history.at(-1)?.sequence ?? 0;
    if (event.sequence <= previous) return;
    this.#history.push(event);
    if (this.#history.length > this.#historyLimit) this.#history.splice(0, this.#history.length - this.#historyLimit);
    for (const subscriber of this.#subscribers) subscriber(event);
  }

  eventsAfter(sequence: number): readonly OperationsDelta[] | undefined {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError("Stream-Sequenz ist ungültig.");
    const first = this.#history[0]?.sequence;
    if (first !== undefined && sequence < first - 1) return undefined;
    return this.#history.filter((event) => event.sequence > sequence);
  }

  subscribe(subscriber: (event: OperationsDelta) => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }
}

export class OperationsRegistry {
  readonly #feeds = new Map<string, OperationsFeed>();
  readonly #maximumFeeds: number;
  readonly #historyLimit: number;

  constructor(maximumFeeds = 2_048, historyLimit = 512) {
    this.#maximumFeeds = maximumFeeds;
    this.#historyLimit = historyLimit;
  }

  forOperator(worldId: string, operatorId: string): OperationsFeed {
    const key = `${worldId}:${operatorId}`;
    const existing = this.#feeds.get(key);
    if (existing !== undefined) return existing;
    if (this.#feeds.size >= this.#maximumFeeds) throw new RangeError("Operations-Stream-Kapazität erschöpft.");
    const feed = new OperationsFeed(this.#historyLimit);
    this.#feeds.set(key, feed);
    return feed;
  }
}

