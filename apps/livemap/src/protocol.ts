export type OperatingStatus =
  | "planned"
  | "running"
  | "waiting"
  | "at_platform"
  | "completed"
  | "cancelled";

export interface PublicTrain {
  id: string;
  operator: string;
  trainNumber: string;
  category: string;
  positionMm: number;
  speedMmPerSecond: number;
  delaySeconds: number;
  nextOperatingPoint: string;
  status: OperatingStatus;
}

export interface Snapshot {
  worldId: string;
  sequence: number;
  at: number;
  trains: PublicTrain[];
}

export interface Delta {
  worldId: string;
  sequence: number;
  at: number;
  changed: PublicTrain[];
  removed: string[];
}

export interface LiveState {
  worldId: string;
  sequence: number;
  at: number;
  trains: Map<string, PublicTrain>;
}

export function initialState(snapshot: Snapshot): LiveState {
  return {
    worldId: snapshot.worldId,
    sequence: snapshot.sequence,
    at: snapshot.at,
    trains: new Map(snapshot.trains.map((train) => [train.id, train])),
  };
}

export function applyDelta(state: LiveState, delta: Delta): LiveState | undefined {
  if (delta.worldId !== state.worldId || delta.sequence !== state.sequence + 1) return undefined;
  const trains = new Map(state.trains);
  delta.changed.forEach((train) => trains.set(train.id, train));
  delta.removed.forEach((id) => trains.delete(id));
  return { worldId: state.worldId, sequence: delta.sequence, at: delta.at, trains };
}

export function interpolatedPosition(train: PublicTrain, snapshotAt: number, renderAt: number): number {
  if (train.status !== "running") return train.positionMm;
  return train.positionMm + train.speedMmPerSecond * Math.max(0, Math.min(renderAt - snapshotAt, 10));
}

interface EventSourcePort {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  addEventListener(type: "reset", listener: () => void): void;
  close(): void;
}

export interface LivemapConnectionDependencies {
  readonly fetch?: typeof fetch;
  readonly eventSource?: (url: string) => EventSourcePort;
  readonly retryDelayMs?: number;
}

/**
 * Verbindet Snapshot und SSE-Deltas. Während einer Resynchronisation wird nur
 * ein Request zugelassen; eintreffende Deltas werden begrenzt gesammelt und
 * nach dem Snapshot monoton angewendet oder verworfen, wenn der Snapshot sie
 * bereits enthält.
 */
export class LivemapConnection {
  #state: LiveState | undefined;
  #events: EventSourcePort | undefined;
  #reloadPromise: Promise<void> | undefined;
  #pendingDeltas: Delta[] = [];
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  readonly #fetch: typeof fetch;
  readonly #eventSource: (url: string) => EventSourcePort;
  readonly #retryDelayMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly worldId: string,
    private readonly changed: (state: LiveState) => void,
    dependencies: LivemapConnectionDependencies = {},
  ) {
    this.#fetch = dependencies.fetch ?? fetch;
    this.#eventSource = dependencies.eventSource ?? ((url) => new EventSource(url));
    this.#retryDelayMs = dependencies.retryDelayMs ?? 1_000;
  }

  async connect(): Promise<void> {
    this.#closed = false;
    await this.#resynchronize();
    if (this.#closed) return;
    this.#events = this.#eventSource(
      `${this.baseUrl}/worlds/${encodeURIComponent(this.worldId)}/livemap/events`,
    );
    this.#events.onmessage = (message) => {
      try {
        this.#accept(JSON.parse(message.data) as Delta);
      } catch {
        this.#scheduleResynchronization();
      }
    };
    this.#events.addEventListener("reset", () => this.#scheduleResynchronization());
  }

  close(): void {
    this.#closed = true;
    this.#events?.close();
    this.#events = undefined;
    this.#pendingDeltas = [];
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
  }

  #accept(delta: Delta): void {
    if (this.#reloadPromise !== undefined) {
      if (this.#pendingDeltas.length < 256) this.#pendingDeltas.push(delta);
      return;
    }
    const next = this.#state === undefined ? undefined : applyDelta(this.#state, delta);
    if (next === undefined) {
      this.#pendingDeltas = [delta];
      this.#scheduleResynchronization();
      return;
    }
    this.#state = next;
    this.changed(next);
  }

  #scheduleResynchronization(): void {
    if (this.#closed || this.#reloadPromise !== undefined || this.#retryTimer !== undefined) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#resynchronize().catch(() => this.#scheduleResynchronization());
    }, this.#retryDelayMs);
  }

  #resynchronize(): Promise<void> {
    if (this.#reloadPromise !== undefined) return this.#reloadPromise;
    const operation = this.#reloadAndDrain();
    this.#reloadPromise = operation.finally(() => {
      this.#reloadPromise = undefined;
    });
    return this.#reloadPromise;
  }

  async #reloadAndDrain(): Promise<void> {
    const response = await this.#fetch(
      `${this.baseUrl}/worlds/${encodeURIComponent(this.worldId)}/livemap/snapshot`,
    );
    if (!response.ok) throw new Error(`Livemap-Snapshot: HTTP ${response.status}`);
    const snapshot = initialState((await response.json()) as Snapshot);
    if (snapshot.worldId !== this.worldId) throw new Error("Livemap-Snapshot gehört zur falschen Welt.");

    let state = snapshot;
    const pending = this.#pendingDeltas
      .splice(0)
      .filter((delta) => delta.worldId === this.worldId && delta.sequence > state.sequence)
      .sort((a, b) => a.sequence - b.sequence);
    for (const delta of pending) {
      if (delta.sequence <= state.sequence) continue;
      const next = applyDelta(state, delta);
      if (next === undefined) {
        this.#pendingDeltas.push(delta);
        break;
      }
      state = next;
    }
    this.#state = state;
    this.changed(state);
  }
}
