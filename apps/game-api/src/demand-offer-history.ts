import { domainEvents, worlds } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import type { OperationalPassengerStopReceipt } from "./operational-passenger-stop.js";
import { DemandError, demandHash, demandInteger, demandList, demandText } from "./demand-store.js";
import { loadCommittedSpfvServices } from "./spfv-demand-projection.js";
import type { PopulationDataEvent } from "./demand-population-data.js";

const MAX_OFFER_REVISIONS = 256;

export interface DemandOfferRevision {
  readonly schemaVersion: "zugfolge-demand-offer-revision/v1";
  readonly worldId: string;
  readonly periodId: string;
  /** Sequenz des atomar nach dem nativen Zustand veröffentlichten Diagramms. */
  readonly worldSequence: number;
  readonly effectiveAtMs: number;
  readonly sourceHash: string;
  readonly services: readonly Readonly<Record<string, unknown>>[];
  readonly provenance: Readonly<Record<string, unknown>>;
}

/** Nur bestätigte Planung ist Angebot. Die Antrags-/Vorschauzeit ist kein
 * Wirksamkeitsbeleg; insbesondere verschiebt ein später Planner-Commit keine
 * bereits gefahrene Entscheidung rückwirkend auf die Bestellzeit. */
export async function loadDemandOfferHistory(db: IdentityDatabase, worldId: string,
  template: Readonly<Record<string, unknown>>, afterWorldSequence: number, throughWorldSequence: number,
  initialAtMs?: number): Promise<readonly DemandOfferRevision[]> {
  demandInteger(afterWorldSequence); demandInteger(throughWorldSequence);
  if (template["worldId"] !== worldId || afterWorldSequence > throughWorldSequence)
    throw new DemandError(503, "Angebotshistorie besitzt eine fremde Welt oder Sequenzgrenze.");
  const [world] = await db.select({ epoch: worlds.epoch }).from(worlds).where(eq(worlds.id, worldId));
  if (world === undefined) throw new DemandError(503, "Angebotshistorie besitzt keine Weltepoche.");
  const predicate = and(eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, "planning.runtime-state"));
  const events = await db.select().from(domainEvents).where(and(predicate,
    gt(domainEvents.sequence, afterWorldSequence), lte(domainEvents.sequence, throughWorldSequence)))
    .orderBy(asc(domainEvents.sequence)).limit(MAX_OFFER_REVISIONS + 1);
  if (initialAtMs !== undefined) {
    demandInteger(initialAtMs);
    const initialAt = new Date(world.epoch.getTime() + initialAtMs);
    if (!Number.isFinite(initialAt.getTime())) throw new DemandError(503, "Angebotshistorie besitzt keine sichere Anfangszeit.");
    const [previous] = await db.select().from(domainEvents).where(and(predicate, lte(domainEvents.sequence, afterWorldSequence),
      lte(domainEvents.occurredAt, initialAt)))
      .orderBy(desc(domainEvents.sequence)).limit(1);
    if (previous !== undefined) events.unshift(previous);
    // Die langsamste Region kann noch am Anfang stehen, obwohl der Planner
    // schon spätere Angebote committet hat. Diese Zwischenstände bleiben nötig.
    const ahead = await db.select().from(domainEvents).where(and(predicate, lte(domainEvents.sequence, afterWorldSequence),
      gt(domainEvents.occurredAt, initialAt))).orderBy(asc(domainEvents.sequence)).limit(MAX_OFFER_REVISIONS + 1);
    events.push(...ahead);
    events.sort((a, b) => a.sequence - b.sequence);
  }
  if (events.length > MAX_OFFER_REVISIONS) throw new DemandError(503, "Angebotshistorie überschreitet die freigegebene Revisionsgrenze.");
  if (events.length === 0) return [];
  const base = demandList(template["services"]), periodId = demandText(template["periodId"]);
  const window = { windowStartMs: demandInteger(template["windowStartMs"]), windowEndMs: demandInteger(template["windowEndMs"]) };
  const revisions: DemandOfferRevision[] = [];
  for (const event of events) {
    const effectiveAtMs = event.occurredAt.getTime() - world.epoch.getTime();
    demandInteger(effectiveAtMs);
    if (event.sequence + 1 > throughWorldSequence) throw new DemandError(503, "Angebotshistorie endet in einem unvollständigen Planungscommit.");
    const accepted = await loadCommittedSpfvServices(db, worldId, base, window, event.sequence + 1);
    const services = new Map(base.map((service) => [demandText(service["trainRunId"]), service]));
    for (const service of accepted.services) {
      const id = demandText(service["trainRunId"]);
      if (services.has(id)) throw new DemandError(503, "Bestätigte Fernverkehrsfahrt ist im Nachfragekorpus doppelt.");
      services.set(id, service);
    }
    revisions.push({ schemaVersion: "zugfolge-demand-offer-revision/v1", worldId, periodId,
      worldSequence: event.sequence + 1, effectiveAtMs, sourceHash: demandHash(event.payload),
      services: [...services.values()], provenance: accepted.provenance });
  }
  for (let index = 1; index < revisions.length; index += 1) {
    if (revisions[index]!.effectiveAtMs < revisions[index - 1]!.effectiveAtMs)
      throw new DemandError(503, "Bestätigte Angebotszeit ist im Weltjournal zurückgegangen.");
  }
  return revisions;
}

/** Ein entfernter Dienst bleibt als Ausfall referenzierbar: bereits vorhandene
 * Ankunftsbelege und gefahrene Abschnitte dürfen nicht aus dem Input fallen. */
export function retainDemandOfferHistory(previous: readonly Readonly<Record<string, unknown>>[],
  next: readonly Readonly<Record<string, unknown>>[]): readonly Readonly<Record<string, unknown>>[] {
  const services = new Map(next.map((service) => [demandText(service["trainRunId"]), service]));
  for (const service of previous) {
    const id = demandText(service["trainRunId"]);
    if (!services.has(id)) services.set(id, { ...service, cancelled: true });
  }
  return [...services.values()];
}

export interface DemandOfferBoundary {
  readonly atMs: number;
  readonly receipts: readonly OperationalPassengerStopReceipt[];
  readonly offer?: DemandOfferRevision;
  readonly population?: PopulationDataEvent;
}

/** Gleichzeitige regionale Belege bleiben gemeinsam; ein dazwischen liegender
 * Planungscommit trennt die Grenze anhand der dauerhaften Weltsequenz. */
export function demandOfferBoundaries(receipts: readonly { readonly receipt: OperationalPassengerStopReceipt; readonly worldSequence: number }[],
  offers: readonly DemandOfferRevision[], earliestMs: number, population: readonly PopulationDataEvent[] = []): readonly DemandOfferBoundary[] {
  type Item = { atMs: number; sequence: number; receipt?: OperationalPassengerStopReceipt; offer?: DemandOfferRevision; population?: PopulationDataEvent };
  const items: Item[] = [
    ...receipts.map(({ receipt, worldSequence }) => ({ atMs: Math.max(earliestMs, receipt.actualTimeMs), sequence: worldSequence, receipt })),
    ...offers.map((offer) => ({ atMs: Math.max(earliestMs, offer.effectiveAtMs), sequence: offer.worldSequence, offer })),
    ...population.map((event) => ({ atMs: Math.max(earliestMs, event.snapshot.effectiveAtMs), sequence: event.worldSequence, population: event })),
  ];
  items.sort((a, b) => a.atMs - b.atMs || a.sequence - b.sequence);
  const boundaries: { atMs: number; receipts: OperationalPassengerStopReceipt[]; offer?: DemandOfferRevision; population?: PopulationDataEvent }[] = [];
  for (const item of items) {
    if (item.population !== undefined) boundaries.push({ atMs: item.atMs, receipts: [], population: item.population });
    else if (item.offer !== undefined) boundaries.push({ atMs: item.atMs, receipts: [], offer: item.offer });
    else {
      const previous = boundaries.at(-1);
      if (previous !== undefined && previous.atMs === item.atMs && previous.offer === undefined && previous.population === undefined) previous.receipts.push(item.receipt!);
      else boundaries.push({ atMs: item.atMs, receipts: [item.receipt!] });
    }
  }
  return boundaries;
}
