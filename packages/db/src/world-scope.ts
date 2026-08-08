import { asc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { domainEvents, type NewDomainEvent } from "./schema/index.js";

/**
 * Jede Postgres-Verbindung, gleich welchen Treibers — nur so bleibt dieses
 * Modul unabhängig von `postgres-js` im Betrieb und `pglite` im Test.
 */
type AnyDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>, any>;

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
    append(event: Omit<NewDomainEvent, "worldId">) {
      return db
        .insert(domainEvents)
        .values({ ...event, worldId })
        .returning();
    },

    /** Hängt einen bereits sequenzierten Kern-Batch atomar an. */
    appendBatch(events: readonly Omit<NewDomainEvent,"worldId">[]) {
      if(events.length===0)return Promise.resolve([]);
      for(let index=1;index<events.length;index+=1){if(events[index]!.sequence!==events[index-1]!.sequence+1)throw new Error("Domain-Ereignisbatch hat eine Sequenzlücke.");}
      return db.insert(domainEvents).values(events.map(event=>({...event,worldId}))).returning();
    },

    /** Alle Ereignisse dieser Welt, in Reihenfolge ihrer Sequenznummer. */
    list() {
      return db
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.worldId, worldId))
        .orderBy(asc(domainEvents.sequence));
    },
  };
}
