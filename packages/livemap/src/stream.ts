export interface PublicTrain {
  readonly id: string; readonly operator: string; readonly trainNumber: string;
  readonly category: string; readonly positionMm: number; readonly speedMmPerSecond: number;
  readonly delaySeconds: number; readonly nextOperatingPoint: string; readonly status: string;
}
export interface LiveSnapshot { readonly worldId: string; readonly sequence: number; readonly at: number; readonly trains: readonly PublicTrain[] }
export interface LiveDelta { readonly worldId: string; readonly sequence: number; readonly at: number; readonly changed: readonly PublicTrain[]; readonly removed: readonly string[] }
export type DeltaListener = (delta: LiveDelta) => void;

/** Weltisolierter In-Process-Fanout. Ein späterer NATS-Adapter implementiert
 * denselben schmalen Vertrag, falls eine Messung getrennte Prozesse verlangt. */
export class LivemapFeed {
  readonly #worldId: string;
  #sequence = 0;
  #at = 0;
  readonly #trains = new Map<string, PublicTrain>();
  readonly #listeners = new Set<DeltaListener>();

  constructor(worldId: string) { this.#worldId = worldId; }
  snapshot(): LiveSnapshot { return { worldId: this.#worldId, sequence: this.#sequence, at: this.#at, trains: [...this.#trains.values()].sort((a,b)=>a.id.localeCompare(b.id)) }; }
  publish(input: Omit<LiveDelta,"worldId"|"sequence">): LiveDelta {
    input.changed.forEach(train=>this.#trains.set(train.id,train));
    input.removed.forEach(id=>this.#trains.delete(id));
    this.#sequence += 1; this.#at=input.at;
    const delta={...input,worldId:this.#worldId,sequence:this.#sequence};
    this.#listeners.forEach(listener=>listener(delta)); return delta;
  }
  subscribe(listener: DeltaListener): () => void { this.#listeners.add(listener); return ()=>this.#listeners.delete(listener); }
}

/** Registry erzwingt die Weltkennung am Zugriffspunkt. */
export class LivemapRegistry {
  readonly #feeds = new Map<string,LivemapFeed>();
  forWorld(worldId:string):LivemapFeed { let feed=this.#feeds.get(worldId); if(feed===undefined){feed=new LivemapFeed(worldId);this.#feeds.set(worldId,feed);} return feed; }
}
