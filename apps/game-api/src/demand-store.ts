import { createHash } from "node:crypto";
import { domainEvents, worldEventLog, worlds } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { DemandRuntime } from "@zugfolge/runtime-native";
import { and, desc, eq, sql } from "drizzle-orm";

export const DEMAND_CHECKPOINT_EVENT = "demand.evaluated";
export const DEMAND_MAX_BYTES = 16 * 1024 * 1024;

export class DemandError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = "DemandError"; }
}

export function demandRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DemandError(503, "Nachfragedaten sind unvollständig.");
  return value as Record<string, unknown>;
}

export function demandText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) throw new DemandError(503, "Nachfragekennung fehlt.");
  return value;
}

export function demandInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DemandError(503, "Nachfragewert ist keine sichere Ganzzahl.");
  return value as number;
}

export function demandList(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new DemandError(503, "Nachfrageliste fehlt.");
  return value.map(demandRecord);
}

/** Kanonischer Transporthash; die fachliche Ergebnissignatur liefert weiterhin Rust. */
export function demandHash(value: unknown): string {
  function canonical(item: unknown): string {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isSafeInteger(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item !== null && typeof item === "object") {
      return `{${Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
    }
    throw new DemandError(503, "Nachfrage enthält nicht kanonische JSON-Werte.");
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface DemandCheckpoint {
  readonly schemaVersion: "zugfolge-demand-checkpoint/v1";
  readonly worldId: string;
  readonly deploymentHash: string;
  readonly inputHash: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>;
  readonly serviceProvenance?: Readonly<Record<string, unknown>>;
}

/** Vorhandenes append-only Weltlog mit Welt-/Typindex, Writer-Fence und Backupabdeckung. */
export class DemandStore {
  private readonly verified = new Map<string, { sequence: number; checkpoint: DemandCheckpoint }>();
  constructor(private readonly db: IdentityDatabase, private readonly runtime: DemandRuntime) {}

  async latest(worldId: string, deploymentHash?: string): Promise<DemandCheckpoint | undefined> {
    const event = await worldEventLog(this.db, worldId).latestOfType(DEMAND_CHECKPOINT_EVENT);
    if (event === undefined) return undefined;
    const cached = this.verified.get(worldId);
    if (cached?.sequence === event.sequence) {
      if (deploymentHash !== undefined && cached.checkpoint.deploymentHash !== deploymentHash) throw new DemandError(409, "Nachfragerelease wurde ohne Periodenübergang geändert.");
      return cached.checkpoint;
    }
    const checkpoint = demandRecord(event.payload) as unknown as DemandCheckpoint;
    if (checkpoint.schemaVersion !== "zugfolge-demand-checkpoint/v1" || checkpoint.worldId !== worldId
      || checkpoint.input["worldId"] !== worldId || checkpoint.result["worldId"] !== worldId
      || (deploymentHash !== undefined && checkpoint.deploymentHash !== deploymentHash)
      || demandHash(checkpoint.input) !== checkpoint.inputHash) throw new DemandError(503, "Nachfrage-Checkpoint verletzt Herkunft oder Weltbindung.");
    // JSONB bewahrt keine Objektfeldreihenfolge; beide Hashes vergleichen Werte.
    const replay = this.runtime.evaluate(checkpoint.input);
    if (demandHash(replay) !== demandHash(checkpoint.result)) throw new DemandError(503, "Nachfrage-Checkpoint besteht den Rust-Replay nicht.");
    this.verified.set(worldId, { sequence: event.sequence, checkpoint });
    return checkpoint;
  }

  async commit(input: Readonly<Record<string, unknown>>, deploymentHash: string, occurredAt: Date,
    serviceProvenance?: Readonly<Record<string, unknown>>): Promise<DemandCheckpoint> {
    const worldId = demandText(input["worldId"]);
    const result = this.runtime.evaluate(input);
    const checkpoint: DemandCheckpoint = {
      schemaVersion: "zugfolge-demand-checkpoint/v1", worldId, deploymentHash,
      inputHash: demandHash(input), input, result,
      ...(serviceProvenance === undefined ? {} : { serviceProvenance }),
    };
    if (Buffer.byteLength(JSON.stringify(checkpoint)) > DEMAND_MAX_BYTES) throw new DemandError(503, "Nachfragefenster überschreitet die freigegebene Größe.");
    await this.db.transaction(async (tx) => {
      const [world] = await tx.select().from(worlds).where(eq(worlds.id, worldId)).for("update");
      if (world === undefined || world.lifecycleStatus !== "active") throw new DemandError(409, "Spielwelt ist nicht aktiv.");
      const previous = await worldEventLog(tx, worldId).latestOfType(DEMAND_CHECKPOINT_EVENT);
      if (previous !== undefined) {
        const before = demandRecord(previous.payload) as unknown as DemandCheckpoint;
        if (before.inputHash === checkpoint.inputHash && before.deploymentHash === deploymentHash) return;
        if (demandInteger(input["revision"]) !== demandInteger(before.input["revision"]) + 1
          || demandInteger(input["nowMs"]) < demandInteger(before.input["nowMs"])
          || demandInteger(input["windowStartMs"]) < demandInteger(before.input["windowStartMs"])) throw new DemandError(409, "Nachfragevorschau ist veraltet.");
        if (before.deploymentHash !== deploymentHash && before.input["periodId"] === input["periodId"]) throw new DemandError(409, "Nachfragedaten sind innerhalb der Fahrplanperiode gepinnt.");
      } else if (input["revision"] !== 1) throw new DemandError(409, "Erste Nachfragerevision muss eins sein.");
      const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents)
        .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
      await worldEventLog(tx, worldId).append({ sequence: (head?.sequence ?? 0) + 1,
        eventType: DEMAND_CHECKPOINT_EVENT, payload: checkpoint, occurredAt });
    });
    this.verified.delete(worldId);
    return checkpoint;
  }
}

/** Journalanhang unter demselben Weltmutex, auch für SPFV-Vorschau und atomare Bestätigung. */
export async function appendDemandEvent(db: IdentityDatabase, worldId: string, eventType: string, payload: unknown, occurredAt: Date): Promise<void> {
  await db.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
  const [head] = await db.select({ sequence: domainEvents.sequence }).from(domainEvents)
    .where(and(eq(domainEvents.worldId, worldId))).orderBy(desc(domainEvents.sequence)).limit(1);
  await worldEventLog(db, worldId).append({ sequence: (head?.sequence ?? 0) + 1, eventType, payload, occurredAt });
}
