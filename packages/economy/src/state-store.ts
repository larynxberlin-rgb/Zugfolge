import { economyOutbox, economyWorldStates } from "@zugfolge/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { EconomyDatabase } from "./ledger.js";
import type { EconomyEffects, EconomyJournalEntry, EconomyNotice, EconomyWorldState } from "./workflow.js";

const TYPE_TAG = "$zugfolgeType";

/** JSONB-Codec für BigInt, Map und Set im deterministischen M6-Zustand. */
export function encodeEconomyValue(value: unknown): unknown {
  if (typeof value === "bigint") return { [TYPE_TAG]: "bigint", value: value.toString() };
  if (value instanceof Map) {
    return { [TYPE_TAG]: "map", entries: [...value].map(([key, item]) => [encodeEconomyValue(key), encodeEconomyValue(item)]) };
  }
  if (value instanceof Set) return { [TYPE_TAG]: "set", values: [...value].map(encodeEconomyValue) };
  if (Array.isArray(value)) return value.map(encodeEconomyValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeEconomyValue(item)]));
  }
  return value;
}

export function decodeEconomyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeEconomyValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record[TYPE_TAG] === "bigint" && typeof record["value"] === "string") return BigInt(record["value"]);
  if (record[TYPE_TAG] === "map" && Array.isArray(record["entries"])) {
    return new Map(
      record["entries"].map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Ungültiger Map-Eintrag im M6-Zustand.");
        return [decodeEconomyValue(entry[0]), decodeEconomyValue(entry[1])];
      }),
    );
  }
  if (record[TYPE_TAG] === "set" && Array.isArray(record["values"])) {
    return new Set(record["values"].map(decodeEconomyValue));
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeEconomyValue(item)]));
}

export class EconomyStateConflictError extends Error {
  constructor(worldId: string, expectedRevision: number | null) {
    super(`M6-Zustand von Welt '${worldId}' ist nicht mehr auf Revision ${expectedRevision ?? "neu"}.`);
    this.name = "EconomyStateConflictError";
  }
}

/**
 * Speichert Zustand und ausstehende Effekte in genau einer Transaktion.
 * `expectedRevision=null` legt die Welt erstmalig an; Folgekommandos geben
 * die Revision an, auf der sie berechnet wurden.
 */
export async function persistEconomyTransition(
  db: EconomyDatabase,
  input: {
    readonly expectedRevision: number | null;
    readonly state: EconomyWorldState;
    readonly effects: EconomyEffects;
    readonly committedAt: Date;
  },
): Promise<void> {
  if (input.expectedRevision !== null && input.state.revision !== input.expectedRevision + 1) {
    throw new EconomyStateConflictError(input.state.worldId, input.expectedRevision);
  }
  if (input.expectedRevision === null && input.state.revision !== 0) {
    throw new EconomyStateConflictError(input.state.worldId, null);
  }

  await db.transaction(async (tx) => {
    const stateValue = {
      worldId: input.state.worldId,
      revision: input.state.revision,
      state: encodeEconomyValue(input.state),
      updatedAt: input.committedAt,
    };
    const written = input.expectedRevision === null
      ? await tx.insert(economyWorldStates).values(stateValue).onConflictDoNothing().returning({ worldId: economyWorldStates.worldId })
      : await tx
          .update(economyWorldStates)
          .set(stateValue)
          .where(and(eq(economyWorldStates.worldId, input.state.worldId), eq(economyWorldStates.revision, input.expectedRevision)))
          .returning({ worldId: economyWorldStates.worldId });
    if (written.length !== 1) throw new EconomyStateConflictError(input.state.worldId, input.expectedRevision);

    const rows = [
      ...input.effects.journal.map((entry) => ({
        worldId: input.state.worldId,
        effectId: entry.idempotencyKey,
        effectType: "journal" as const,
        payload: encodeEconomyValue(entry),
        occurredAt: new Date(entry.at * 1_000),
        enqueuedAt: input.committedAt,
      })),
      ...input.effects.notices.map((notice) => ({
        worldId: input.state.worldId,
        effectId: notice.id,
        effectType: "notice" as const,
        payload: encodeEconomyValue(notice),
        occurredAt: new Date(notice.at * 1_000),
        enqueuedAt: input.committedAt,
      })),
    ];
    if (rows.length > 0) {
      await tx
        .insert(economyOutbox)
        .values(rows)
        .onConflictDoNothing({ target: [economyOutbox.worldId, economyOutbox.effectType, economyOutbox.effectId] });
    }
  });
}

export async function loadEconomyWorldState(
  db: EconomyDatabase,
  worldId: string,
): Promise<EconomyWorldState | undefined> {
  const [row] = await db
    .select({ state: economyWorldStates.state })
    .from(economyWorldStates)
    .where(eq(economyWorldStates.worldId, worldId))
    .limit(1);
  return row === undefined ? undefined : (decodeEconomyValue(row.state) as EconomyWorldState);
}

export interface PendingEconomyEffect {
  readonly id: string;
  readonly worldId: string;
  readonly effectId: string;
  readonly effectType: "journal" | "notice";
  readonly payload: EconomyJournalEntry | EconomyNotice;
  readonly attempts: number;
}

export async function listPendingEconomyEffects(
  db: EconomyDatabase,
  worldId: string,
  limit = 100,
): Promise<readonly PendingEconomyEffect[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("Outbox-Limit ist ungültig.");
  const rows = await db
    .select()
    .from(economyOutbox)
    .where(and(eq(economyOutbox.worldId, worldId), isNull(economyOutbox.processedAt)))
    .orderBy(asc(economyOutbox.enqueuedAt), asc(economyOutbox.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    worldId: row.worldId,
    effectId: row.effectId,
    effectType: row.effectType,
    payload: decodeEconomyValue(row.payload) as EconomyJournalEntry | EconomyNotice,
    attempts: row.attempts,
  }));
}

/** Liefert die transaktionale Outbox aus; Zieladapter sind selbst dauerhaft idempotent. */
export async function dispatchEconomyOutbox(
  db: EconomyDatabase,
  worldId: string,
  adapters: {
    readonly postJournal: (entry: EconomyJournalEntry) => Promise<void>;
    readonly sendNotice: (notice: EconomyNotice) => Promise<void>;
  },
  processedAt: Date,
): Promise<number> {
  const pending = await listPendingEconomyEffects(db, worldId);
  let processed = 0;
  for (const effect of pending) {
    try {
      if (effect.effectType === "journal") await adapters.postJournal(effect.payload as EconomyJournalEntry);
      else await adapters.sendNotice(effect.payload as EconomyNotice);
      await db
        .update(economyOutbox)
        .set({ processedAt, lastErrorCode: null })
        .where(and(eq(economyOutbox.id, effect.id), isNull(economyOutbox.processedAt)));
      processed += 1;
    } catch (error) {
      await db
        .update(economyOutbox)
        .set({
          attempts: sql`${economyOutbox.attempts} + 1`,
          lastErrorCode: error instanceof Error && error.name !== "Error" ? error.name : "dispatch_failed",
        })
        .where(eq(economyOutbox.id, effect.id));
      throw error;
    }
  }
  return processed;
}
