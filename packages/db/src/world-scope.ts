import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { domainEvents, worlds, type NewDomainEvent } from "./schema/index.js";

/**
 * Jede Postgres-Verbindung, gleich welchen Treibers — nur so bleibt dieses
 * Modul unabhängig von `postgres-js` im Betrieb und `pglite` im Test.
 */
type AnyDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

export class EventSequenceError extends Error {
  constructor(worldId: string, expected: number, received: number) {
    super(`Domain-Ereignis für Welt '${worldId}' erwartet Sequenz ${expected}, erhielt ${received}.`);
    this.name = "EventSequenceError";
  }
}

function assertBatchShape(worldId: string, events: readonly Omit<NewDomainEvent, "worldId">[]): void {
  for (const [index, event] of events.entries()) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
      throw new EventSequenceError(worldId, index === 0 ? 1 : events[index - 1]!.sequence + 1, event.sequence);
    }
    if (index > 0 && event.sequence !== events[index - 1]!.sequence + 1) {
      throw new EventSequenceError(worldId, events[index - 1]!.sequence + 1, event.sequence);
    }
  }
}

/**
 * Das Event-Log einer einzigen Welt (Invariante 4).
 *
 * `worldId` steht im Konstruktor, nicht in jedem einzelnen Aufruf — anders
 * als eine Abfrage, die die Welt als Parameter mitführt, kann sie hier nicht
 * vergessen werden, weil es keinen Aufruf ohne sie gibt. Das ist der
 * "automatisierte Nachweis statt Disziplin" aus M2.2: Wer das Log einer Welt
 * lesen will, bekommt gar keinen anderen Weg angeboten.
 */
export function worldEventLog<TDatabase extends AnyDatabase>(db: TDatabase, worldId: string) {
  return {
    /** Hängt ein Ereignis ans Ende des Logs dieser Welt an. */
    async append(event: Omit<NewDomainEvent, "worldId">) {
      return this.appendBatch([event]);
    },

    /** Hängt einen bereits sequenzierten Kern-Batch atomar an. */
    async appendBatch(events: readonly Omit<NewDomainEvent, "worldId">[]) {
      if (events.length === 0) return [];
      assertBatchShape(worldId, events);
      return db.transaction(async (tx) => {
        // Die Weltzeile ist der per-world Mutex. Damit können zwei Writer die
        // nächste Sequenz nicht gleichzeitig aus demselben alten Head ableiten.
        await tx.execute(
          sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`,
        );
        const [last] = await tx
          .select({ sequence: domainEvents.sequence })
          .from(domainEvents)
          .where(eq(domainEvents.worldId, worldId))
          .orderBy(desc(domainEvents.sequence))
          .limit(1);
        const expected = (last?.sequence ?? 0) + 1;
        if (events[0]!.sequence !== expected) {
          throw new EventSequenceError(worldId, expected, events[0]!.sequence);
        }
        return tx
          .insert(domainEvents)
          .values(events.map((event) => ({ ...event, worldId })))
          .returning();
      });
    },

    /** Alle Ereignisse dieser Welt, in Reihenfolge ihrer Sequenznummer. */
    list() {
      return db
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.worldId, worldId))
        .orderBy(asc(domainEvents.sequence));
    },

    /** Begrenzter Replay-Ausschnitt nach einer bereits verarbeiteten Sequenz. */
    listAfter(sequence: number, limit = 500) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError("Replay-Sequenz ist ungültig.");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new RangeError("Replay-Limit ist ungültig.");
      return db
        .select()
        .from(domainEvents)
        .where(and(eq(domainEvents.worldId, worldId), gt(domainEvents.sequence, sequence)))
        .orderBy(asc(domainEvents.sequence))
        .limit(limit);
    },

    /** Jüngstes Projektionsergebnis eines Typs, etwa `planning.diagram`. */
    async latestOfType(eventType: string) {
      const [event] = await db
        .select()
        .from(domainEvents)
        .where(and(eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, eventType)))
        .orderBy(desc(domainEvents.sequence))
        .limit(1);
      return event;
    },
  };
}
