export type OperatingStatus = "planned" | "running" | "waiting" | "at_platform" | "completed" | "cancelled";
export interface PublicTrain { id: string; operator: string; trainNumber: string; category: string; positionMm: number; speedMmPerSecond: number; delaySeconds: number; nextOperatingPoint: string; status: OperatingStatus }
export interface Snapshot { worldId: string; sequence: number; at: number; trains: PublicTrain[] }
export interface Delta { worldId: string; sequence: number; at: number; changed: PublicTrain[]; removed: string[] }
export interface LiveState { worldId: string; sequence: number; at: number; trains: Map<string, PublicTrain> }

export function initialState(snapshot: Snapshot): LiveState { return { worldId: snapshot.worldId, sequence: snapshot.sequence, at: snapshot.at, trains: new Map(snapshot.trains.map((train) => [train.id, train])) }; }
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

/** Verbindet Initialsnapshot und sequenzierte Server-Sent-Event-Deltas. Bei
 * jeder Lücke wird automatisch ein neuer Snapshot geladen. */
export class LivemapConnection {
  #state: LiveState | undefined;
  #events: EventSource | undefined;
  constructor(private readonly baseUrl:string,private readonly worldId:string,private readonly changed:(state:LiveState)=>void){}
  async connect():Promise<void>{await this.reload();this.#events=new EventSource(`${this.baseUrl}/worlds/${this.worldId}/livemap/events`);this.#events.onmessage=(message)=>{const delta=JSON.parse(message.data) as Delta;const next=this.#state===undefined?undefined:applyDelta(this.#state,delta);if(next===undefined){void this.reload();return;}this.#state=next;this.changed(next);};}
  close():void{this.#events?.close();}
  private async reload():Promise<void>{const response=await fetch(`${this.baseUrl}/worlds/${this.worldId}/livemap/snapshot`);if(!response.ok)throw new Error(`Livemap-Snapshot: HTTP ${response.status}`);this.#state=initialState(await response.json() as Snapshot);this.changed(this.#state);}
}
