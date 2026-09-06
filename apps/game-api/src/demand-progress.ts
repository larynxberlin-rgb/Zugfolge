import { domainEvents, regionalSimulationStates, worlds } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { DemandRuntime } from "@zugfolge/runtime-native";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { DEMAND_PROGRESS_EVENT, DemandError, DemandStore, demandHash, demandInteger, demandList, demandRecord, demandText, type DemandCheckpoint } from "./demand-store.js";
import { decodeOperationalPassengerStop, type OperationalPassengerStopReceipt } from "./operational-passenger-stop.js";
import { loadDemandPoolSeed } from "./demand-pool-seeds.js";
import { demandOfferBoundaries, loadDemandOfferHistory, retainDemandOfferHistory, type DemandOfferRevision } from "./demand-offer-history.js";

export interface DemandRegionBinding {
  readonly worldId: string;
  readonly regionId: string;
  readonly initializationHash: string;
}

const RECEIPT_TYPES = ["operations.passenger-stop-arrival", "operations.passenger-stop-departure"];
const MAX_RECEIPTS = 40_000;

interface DemandProgressCursor {
  readonly schemaVersion: "zugfolge-demand-progress-cursor/v1";
  readonly worldId: string;
  readonly initialInputHash: string;
  readonly throughWorldSequence: number;
  readonly safeThroughMs: number;
  readonly receiptSetHash: string;
  readonly regions: readonly Readonly<Record<string, unknown>>[];
  readonly receipts: readonly OperationalPassengerStopReceipt[];
  readonly pendingReceipts: readonly OperationalPassengerStopReceipt[];
  readonly receiptWorldSequences?: Readonly<Record<string, number>>;
  readonly offerServices?: readonly Readonly<Record<string, unknown>>[];
  readonly offerSourceServices?: readonly Readonly<Record<string, unknown>>[];
  readonly pendingOffers?: readonly DemandOfferRevision[];
}

/** Der Zustand und sein Journaltail werden durch denselben Weltmutex gelesen. */
export async function demandRegionalWatermark(db: IdentityDatabase, worldId: string, bindings: readonly DemandRegionBinding[]) {
  if (bindings.length === 0 || bindings.length > 256 || bindings.some((binding) => binding.worldId !== worldId)
    || new Set(bindings.map((binding) => binding.regionId)).size !== bindings.length) throw new DemandError(503, "Vollständige regionale Nachfragebindung fehlt.");
  const rows = await db.select({ regionId: regionalSimulationStates.regionId, initializationHash: regionalSimulationStates.initializationHash,
    revision: regionalSimulationStates.revision,
    worldId: sql<unknown>`${regionalSimulationStates.state}->'world'->>'worldId'`,
    nowMs: sql<unknown>`${regionalSimulationStates.state}->'world'->>'nowMs'`,
    nativeEventSequence: sql<unknown>`${regionalSimulationStates.state}->'world'->>'eventSequence'`,
  }).from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, worldId),
    inArray(regionalSimulationStates.regionId, bindings.map((binding) => binding.regionId))));
  if (rows.length !== bindings.length) throw new DemandError(503, "Eine Nachfrage-Region hat noch keinen bestätigten Betriebsstand.");
  const regions = rows.map((row) => {
    if (row.worldId !== worldId || row.initializationHash !== bindings.find((binding) => binding.regionId === row.regionId)?.initializationHash
      || !/^\d+$/u.test(String(row.nowMs)) || !/^\d+$/u.test(String(row.nativeEventSequence))) throw new DemandError(503, "Regionaler Nachfragebeleg verletzt den signierten Initialisierungspin.");
    return { regionId: row.regionId, initializationHash: row.initializationHash, commitSequence: demandInteger(row.revision),
      nativeEventSequence: demandInteger(Number(row.nativeEventSequence)), completeThroughMs: demandInteger(Number(row.nowMs)) };
  }).sort((a, b) => a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0);
  // Ein nachfolgendes Kommando darf am aktuellen Zeitpunkt noch Ereignisse
  // erzeugen. Erst der strikt davor liegende Zeitpunkt ist vollständig.
  return { regions, nowMs: Math.min(...regions.map((row) => row.completeThroughMs)),
    safeThroughMs: Math.max(0, Math.min(...regions.map((row) => row.completeThroughMs)) - 1) };
}

function cursorOf(checkpoint: DemandCheckpoint): DemandProgressCursor | undefined {
  if (checkpoint.progressCursor === undefined) return undefined;
  const cursor = checkpoint.progressCursor as unknown as DemandProgressCursor;
  if (cursor.schemaVersion !== "zugfolge-demand-progress-cursor/v1" || cursor.worldId !== checkpoint.worldId
    || !Array.isArray(cursor.receipts) || !Array.isArray(cursor.pendingReceipts)
    || cursor.receipts.length + cursor.pendingReceipts.length > MAX_RECEIPTS
    || demandHash(cursor.receipts) !== cursor.receiptSetHash) throw new DemandError(503, "Nachfrage-Belegcursor ist ungültig.");
  demandInteger(cursor.safeThroughMs); demandInteger(cursor.throughWorldSequence);
  return cursor;
}

/** Verlustfreier Transport in den existierenden Rust-Fortschrittsvertrag. */
export function demandProgressFromReceipts(worldId: string, nowMs: number, receipts: readonly OperationalPassengerStopReceipt[]) {
  const trains = new Map<string, Map<string, { stopId: string; actualArrivalMs: number | null; actualDepartureMs: number | null }>>();
  for (const receipt of receipts) {
    if (receipt.worldId !== worldId || receipt.actualTimeMs > nowMs) throw new DemandError(503, "Haltbeleg ist fremd oder noch nicht vollständig bestätigt.");
    const stops = trains.get(receipt.trainRunId) ?? new Map();
    const stop = stops.get(receipt.stopId) ?? { stopId: receipt.stopId, actualArrivalMs: null, actualDepartureMs: null };
    const field = receipt.kind === "arrival" ? "actualArrivalMs" : "actualDepartureMs";
    if (stop[field] !== null && stop[field] !== receipt.actualTimeMs) throw new DemandError(503, "Haltbelege widersprechen sich.");
    stop[field] = receipt.actualTimeMs; stops.set(receipt.stopId, stop); trains.set(receipt.trainRunId, stops);
  }
  return { schemaVersion: "demand-operational-progress/v1", worldId, asOfMs: nowMs,
    receiptId: demandHash({ worldId, nowMs, receipts }), trains: [...trains.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([trainRunId, stops]) => ({ trainRunId, stops: [...stops.values()].sort((a, b) => a.stopId < b.stopId ? -1 : a.stopId > b.stopId ? 1 : 0) })) };
}

function orderReceipts(receipts: readonly OperationalPassengerStopReceipt[]) {
  return [...receipts].sort((a, b) => a.actualTimeMs - b.actualTimeMs || (a.trainRunId < b.trainRunId ? -1 : a.trainRunId > b.trainRunId ? 1 : 0)
    || a.stopSequence - b.stopSequence || (a.kind === b.kind ? 0 : a.kind === "arrival" ? -1 : 1));
}

function validateReceiptSet(receipts: readonly OperationalPassengerStopReceipt[], services: readonly Record<string, unknown>[]) {
  const ids = new Map<string, string>();
  const stops = new Map<string, OperationalPassengerStopReceipt>();
  const bindings = new Map<string, string>();
  for (const receipt of receipts) {
    const service = services.find((row) => row["trainRunId"] === receipt.trainRunId);
    const stop = service === undefined ? undefined : demandList(service["stops"])[receipt.stopSequence];
    if (stop?.["stopId"] !== receipt.stopId || stop["passengerStop"] !== true) throw new DemandError(503, "Nativer Fahrgasthalt passt nicht zum gepinnten Nachfrageangebot.");
    const hash = demandHash(receipt);
    if (ids.has(receipt.receiptId) && ids.get(receipt.receiptId) !== hash) throw new DemandError(503, "Widersprüchlich wiederholter Haltbeleg.");
    ids.set(receipt.receiptId, hash);
    const stopKey = `${receipt.trainRunId}\u0000${receipt.stopId}`;
    const binding = demandHash({ serviceRunId: receipt.serviceRunId, stopPlanHash: receipt.stopPlanHash, stopSequence: receipt.stopSequence });
    if (bindings.has(stopKey) && bindings.get(stopKey) !== binding) throw new DemandError(503, "Ankunft und Abfahrt verwenden verschiedene Haltbindungen.");
    bindings.set(stopKey, binding);
    const key = `${receipt.trainRunId}\u0000${receipt.stopId}\u0000${receipt.kind}`;
    const prior = stops.get(key);
    if (prior !== undefined && demandHash(prior) !== hash) throw new DemandError(503, "Halt wurde mit einer anderen Bindung wiederholt.");
    stops.set(key, receipt);
  }
  return orderReceipts([...stops.values()]);
}

/** Ist-Zeiten sind Belege; nur nachfolgende Zeiten bleiben daraus abgeleitete Prognosen. */
export function servicesWithConfirmedStops(services: readonly Record<string, unknown>[], receipts: readonly OperationalPassengerStopReceipt[]) {
  return services.map((service) => {
    const actual = receipts.filter((receipt) => receipt.trainRunId === service["trainRunId"]);
    let delay = 0, lastDeparture = -1;
    return { ...service, stops: demandList(service["stops"]).map((stop) => {
      const arrival = actual.find((receipt) => receipt.stopId === stop["stopId"] && receipt.kind === "arrival")?.actualTimeMs;
      const departure = actual.find((receipt) => receipt.stopId === stop["stopId"] && receipt.kind === "departure")?.actualTimeMs;
      const scheduledArrival = demandInteger(stop["arrivalMs"]), scheduledDeparture = demandInteger(stop["departureMs"]);
      if (arrival !== undefined) delay = Math.max(0, arrival - scheduledArrival);
      const arrivalMs = arrival ?? Math.max(scheduledArrival + delay, lastDeparture + 1);
      if (departure !== undefined) delay = Math.max(0, departure - scheduledDeparture);
      const departureMs = departure ?? Math.max(arrivalMs, scheduledDeparture + delay);
      lastDeparture = departureMs;
      return { ...stop, arrivalMs, departureMs };
    }) };
  });
}

export function hasUnfinishedActualJourney(checkpoint: DemandCheckpoint | undefined): boolean {
  if (checkpoint?.progressCursor === undefined || checkpoint.result["operationalProgress"] === null
    || checkpoint.result["operationalProgress"] === undefined) return false;
  const trains = demandList(demandRecord(checkpoint.result["operationalProgress"])["trains"]);
  const actual = (trainRunId: unknown, stopId: unknown, field: string) => {
    const train = trains.find((row) => row["trainRunId"] === trainRunId);
    return train === undefined ? undefined : demandList(train["stops"]).find((stop) => stop["stopId"] === stopId)?.[field];
  };
  return demandList(checkpoint.result["choices"]).some((choice) => {
    const legs = demandList(choice["trains"]);
    const begun = legs.some((leg) => actual(leg["trainRunId"], leg["boardingStopId"], "actualDepartureMs") != null);
    const last = legs.at(-1);
    return begun && last !== undefined && actual(last["trainRunId"], last["alightingStopId"], "actualArrivalMs") == null;
  });
}

/** Journalconsumer: keine Zugwahl oder Personenmaterialisierung in TypeScript. */
export class DemandProgressConsumer {
  constructor(private readonly db: IdentityDatabase, private readonly runtime: DemandRuntime,
    private readonly bindings: () => readonly DemandRegionBinding[]) {}

  async advance(template: Readonly<Record<string, unknown>>, proposedServices: readonly Record<string, unknown>[], deploymentHash: string,
    occurredAt: Date, provenance: Readonly<Record<string, unknown>>): Promise<DemandCheckpoint> {
    const worldId = demandText(template["worldId"]);
    return this.db.transaction(async (tx) => {
      await tx.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, worldId)).for("update");
      const watermark = await demandRegionalWatermark(tx, worldId, this.bindings());
      const store = new DemandStore(tx, this.runtime);
      let previous = await store.latest(worldId);
      const published = previous;
      let revision = previous === undefined ? 0 : demandInteger(previous.input["revision"]);
      let cursor = previous === undefined ? undefined : cursorOf(previous);
      const initializing = cursor === undefined || previous?.input["periodId"] !== template["periodId"];
      const samePool = previous?.input["periodId"] === template["periodId"];
      if (samePool && previous!.deploymentHash !== deploymentHash) throw new DemandError(409, "Nachfragedaten sind innerhalb der Fahrplanperiode gepinnt.");
      if (!samePool && hasUnfinishedActualJourney(previous))
        throw new DemandError(409, "Begonnene Fahrgastreisen behalten ihren Nachfragepool bis zur bestätigten Zielankunft.");
      if (cursor !== undefined && samePool && watermark.safeThroughMs < cursor.safeThroughMs) throw new DemandError(409, "Regionale Nachfragezeit ist zurückgegangen.");
      if (cursor !== undefined && samePool) {
        for (const old of cursor.regions) {
          const region = watermark.regions.find((row) => row.regionId === old["regionId"]);
          if (region === undefined || region.initializationHash !== old["initializationHash"]
            || region.commitSequence < demandInteger(old["commitSequence"])
            || region.nativeEventSequence < demandInteger(old["nativeEventSequence"])) throw new DemandError(409, "Nachfrage-Regionsbindung oder Belegsequenz ist zurückgegangen.");
        }
        if (cursor.regions.length !== watermark.regions.length) throw new DemandError(409, "Nachfrage-Regionsmenge wurde innerhalb des Pools geändert.");
      }
      let hasSeed = false;
      if (!samePool || cursor === undefined) {
        const seed = await loadDemandPoolSeed(tx, this.runtime, worldId, demandText(template["periodId"]), deploymentHash);
        hasSeed = seed !== undefined;
        const firstDeparture = Math.min(...demandList(template["services"]).map((service) => demandInteger(demandList(service["stops"])[0]!["departureMs"])));
        if (seed === undefined && watermark.regions.some((region) => region.completeThroughMs > firstDeparture))
          throw new DemandError(503, "Autoritative Nachfrage benötigt ihren Anfangscheckpoint vor der ersten Abfahrt.");
        if (seed !== undefined && seed.templateHash !== demandHash(template)) throw new DemandError(409, "Nachfragepool widerspricht seinem gepinnten Anfang.");
        // Auch ohne vorab gespeichertes Seed beginnt die Basis ohne spätere
        // Planner-Angebote; diese werden unten aus ihren Commitzeiten geladen.
        const input = seed?.input ?? { ...template, nowMs: watermark.nowMs, revision: revision + 1 };
        cursor = { schemaVersion: "zugfolge-demand-progress-cursor/v1", worldId, initialInputHash: demandHash(input), throughWorldSequence: seed?.startWorldSequence ?? 0,
          safeThroughMs: demandInteger(input["nowMs"]), receiptSetHash: demandHash([]), regions: seed?.initialWatermark.regions ?? watermark.regions, receipts: [], pendingReceipts: [] };
        if (seed === undefined || published === undefined) {
          previous = await store.commit({ ...input, revision: ++revision }, deploymentHash, occurredAt, provenance,
            cursor as unknown as Record<string, unknown>, true, DEMAND_PROGRESS_EVENT);
        } else {
          previous = { schemaVersion: "zugfolge-demand-checkpoint/v1", worldId, deploymentHash, inputHash: seed.inputHash,
            input: seed.input, result: seed.result, progressCursor: cursor as unknown as Record<string, unknown>, progressCursorHash: demandHash(cursor) };
        }
      }
      const before = previous!;
      const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents)
        .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
      const history = await loadDemandOfferHistory(tx, worldId, template, cursor!.throughWorldSequence, head?.sequence ?? 0,
        initializing || cursor!.offerServices === undefined ? demandInteger(before.input["nowMs"]) : undefined);
      let offerServices = cursor!.offerServices ?? demandList(template["services"]);
      const offers = [...cursor!.pendingOffers ?? [], ...history].sort((a, b) => a.effectiveAtMs - b.effectiveAtMs || a.worldSequence - b.worldSequence);
      if (offers.length > 256 || offers.some((offer) => offer.schemaVersion !== "zugfolge-demand-offer-revision/v1"
        || offer.worldId !== worldId || offer.periodId !== template["periodId"])) throw new DemandError(503, "Angebotscursor verletzt Welt-, Perioden- oder Mengengrenze.");
      for (const offer of offers) {
        demandInteger(offer.worldSequence); demandInteger(offer.effectiveAtMs); demandList(offer.services);
        if (!/^[a-f0-9]{64}$/u.test(offer.sourceHash)) throw new DemandError(503, "Angebotscursor besitzt keinen Quellenhash.");
      }
      if (!initializing && cursor!.offerServices !== undefined && history.some((offer) => offer.effectiveAtMs < demandInteger(before.input["nowMs"])))
        throw new DemandError(503, "Ein Angebotscommit liegt vor dem kausal gesicherten Nachfragecheckpoint.");
      const sourceServices = history.at(-1)?.services ?? cursor!.offerSourceServices ?? demandList(template["services"]);
      const serviceSignature = (services: readonly Readonly<Record<string, unknown>>[]) => demandHash([...services].sort((a, b) =>
        demandText(a["trainRunId"]) < demandText(b["trainRunId"]) ? -1 : demandText(a["trainRunId"]) > demandText(b["trainRunId"]) ? 1 : 0));
      if (serviceSignature(sourceServices) !== serviceSignature(proposedServices))
        throw new DemandError(503, "Nachfrage-Angebotsänderung besitzt keinen zeitgebundenen autoritativen Beleg.");
      let knownServices = offerServices;
      for (const offer of offers) knownServices = retainDemandOfferHistory(knownServices, offer.services);
      const serviceIds = new Set(knownServices.map((service) => demandText(service["trainRunId"])));
      const receiptWorldSequences = { ...cursor!.receiptWorldSequences };
      const events = await tx.select().from(domainEvents).where(and(eq(domainEvents.worldId, worldId),
        gt(domainEvents.sequence, cursor!.throughWorldSequence), inArray(domainEvents.eventType, RECEIPT_TYPES),
        inArray(sql<string>`${domainEvents.payload}->>'trainRunId'`, [...serviceIds])))
        .orderBy(asc(domainEvents.sequence)).limit(MAX_RECEIPTS + 1);
      if (events.length > MAX_RECEIPTS) throw new DemandError(503, "Nachfrage-Journaltail überschreitet die freigegebene Grenze.");
      const received = events.flatMap((event) => {
        const payload = demandRecord(event.payload);
        const region = watermark.regions.find((row) => row.regionId === payload["regionId"]);
        if (region === undefined || demandInteger(payload["commitSequence"]) > region.commitSequence
          || demandInteger(payload["nativeEventSequence"]) > region.nativeEventSequence) throw new DemandError(503, "Haltbeleg besitzt keinen bestätigten Regionscommit.");
        if (typeof payload["detail"] !== "string") throw new DemandError(503, "Nativer Haltbeleg fehlt im Journal.");
        const receipt = decodeOperationalPassengerStop(event.eventType === RECEIPT_TYPES[0] ? "passenger-stop-arrival" : "passenger-stop-departure",
          payload["detail"], demandText(payload["subjectId"]), demandInteger(payload["simulationTimeMs"]), worldId);
        receiptWorldSequences[receipt.receiptId] ??= event.sequence;
        return [receipt];
      });
      const all = validateReceiptSet([...cursor!.receipts, ...cursor!.pendingReceipts, ...received], knownServices);
      // Ein echtes Seed bindet die Journalgrenze vor der Abfahrt, auch bei0.
      if (initializing && !hasSeed && all.some((receipt) => receipt.kind === "departure" && receipt.actualTimeMs <= demandInteger(before.input["nowMs"])))
        throw new DemandError(503, "Ein Abfahrtsbeleg liegt bereits vor dem Nachfrage-Anfangscheckpoint.");
      if (all.length > MAX_RECEIPTS) throw new DemandError(503, "Nachfrage-Belegmenge überschreitet die freigegebene Grenze.");
      const confirmed = all.filter((receipt) => watermark.nowMs > 0 && receipt.actualTimeMs <= watermark.safeThroughMs);
      const pendingReceipts = all.filter((receipt) => watermark.nowMs === 0 || receipt.actualTimeMs > watermark.safeThroughMs);
      const priorIds = new Set(cursor!.receipts.map((receipt) => receipt.receiptId));
      const newReceipts = confirmed.filter((receipt) => !priorIds.has(receipt.receiptId));
      if (newReceipts.some((receipt) => receipt.actualTimeMs < demandInteger(before.input["nowMs"]) && !(initializing && receipt.kind === "arrival")))
        throw new DemandError(503, "Ein Haltbeleg liegt vor dem kausal gesicherten Nachfragecheckpoint.");
      const confirmedOffers = offers.filter((offer) => watermark.nowMs > 0 && offer.effectiveAtMs <= watermark.safeThroughMs);
      const pendingOffers = offers.filter((offer) => watermark.nowMs === 0 || offer.effectiveAtMs > watermark.safeThroughMs);
      const boundaries = demandOfferBoundaries(newReceipts.map((receipt) => {
        const worldSequence = receiptWorldSequences[receipt.receiptId];
        if (worldSequence === undefined && confirmedOffers.some((offer) => offer.effectiveAtMs === receipt.actualTimeMs))
          throw new DemandError(503, "Historischer Haltbeleg besitzt keine eindeutige Reihenfolge zum Angebotscommit.");
        return { receipt, worldSequence: worldSequence ?? 0 };
      }), confirmedOffers, demandInteger(before.input["nowMs"]));
      let current = before;
      let currentProvenance = before.serviceProvenance ?? provenance;
      const appliedReceipts = new Map(cursor!.receipts.map((receipt) => [receipt.receiptId, receipt]));
      // Planungscommit und Halte dürfen im Catch-up nicht vertauscht werden.
      // Ein Angebot gilt erst ab seiner bestätigten Zeit und Weltsequenz.
      for (const boundary of boundaries) {
        for (const receipt of boundary.receipts) appliedReceipts.set(receipt.receiptId, receipt);
        if (boundary.offer !== undefined) {
          offerServices = retainDemandOfferHistory(offerServices, boundary.offer.services);
          currentProvenance = boundary.offer.provenance;
        }
        const atReceipts = orderReceipts([...appliedReceipts.values()]);
        const input = { ...template, nowMs: boundary.atMs, revision: ++revision,
          services: servicesWithConfirmedStops(offerServices, atReceipts),
          previousEvaluation: { services: current.input["services"], result: current.result },
          operationalProgress: demandProgressFromReceipts(worldId, boundary.atMs, atReceipts) };
        const boundaryCursor: DemandProgressCursor = { ...cursor!, throughWorldSequence: head?.sequence ?? 0, safeThroughMs: boundary.atMs,
          receiptSetHash: demandHash(atReceipts), regions: watermark.regions, receipts: atReceipts,
          pendingReceipts: all.filter((receipt) => !appliedReceipts.has(receipt.receiptId)), receiptWorldSequences,
          offerServices, offerSourceServices: sourceServices, pendingOffers };
        current = await store.commit(input, deploymentHash, occurredAt, currentProvenance,
          boundaryCursor as unknown as Record<string, unknown>, true, DEMAND_PROGRESS_EVENT);
      }
      const nextServices = servicesWithConfirmedStops(offerServices, confirmed);
      const changed = initializing || boundaries.length > 0 || history.length > 0 || demandHash(nextServices) !== demandHash(before.input["services"])
        || cursor!.safeThroughMs !== watermark.safeThroughMs || received.length > 0 || (head?.sequence ?? 0) > cursor!.throughWorldSequence;
      if (!changed) return before;
      const targetTime = Math.max(demandInteger(current.input["nowMs"]), watermark.safeThroughMs,
        published === undefined ? 0 : demandInteger(published.input["nowMs"]));
      const input = { ...template, nowMs: targetTime, revision: ++revision,
        services: nextServices, ...(confirmed.length === 0 ? {} : {
          previousEvaluation: { services: current.input["services"], result: current.result },
          operationalProgress: demandProgressFromReceipts(worldId, targetTime, confirmed) }) };
      // Jede Zeitgrenze hat einen nativen Replayinput; alle werden gemeinsam
      // mit dem finalen Cursor committet. Inputs enthalten keine rekursive Kette.
      const [writeHead] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents)
        .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
      const finalCursor: DemandProgressCursor = { ...cursor!, throughWorldSequence: (writeHead?.sequence ?? 0) + 1, safeThroughMs: targetTime,
        receiptSetHash: demandHash(confirmed), regions: watermark.regions, receipts: confirmed, pendingReceipts,
        receiptWorldSequences, offerServices, offerSourceServices: sourceServices, pendingOffers };
      return store.commit(input, deploymentHash, occurredAt, currentProvenance,
        finalCursor as unknown as Record<string, unknown>, true);
    });
  }
}
