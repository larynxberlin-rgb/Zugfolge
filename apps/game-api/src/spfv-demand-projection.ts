import { domainEvents, operators, simulationCommands } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { DemandError, demandHash, demandInteger, demandList, demandRecord, demandText } from "./demand-store.js";

type RecordValue = Readonly<Record<string, unknown>>;
const MAX_SERVICES = 2_000;
const caches = new WeakMap<IdentityDatabase, Map<string, { key: string; result: CommittedSpfvServices }>>();

export interface CommittedSpfvServices {
  readonly services: readonly RecordValue[];
  /** Fahrplan und Plätze sind bestätigt; die übernommene Angebotsqualität bleibt Prognose. */
  readonly provenance: { readonly kind: "forecast"; readonly planningRevision: number | null;
    readonly planningStateHash: string | null; readonly referenceTrainIds: readonly string[] };
}

function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DemandError(503, message);
}

function bounded<T>(items: readonly T[]): readonly T[] {
  requireFact(items.length <= MAX_SERVICES, "Bestätigte Fernverkehrsprojektion überschreitet das Nachfragefenster.");
  return items;
}

function milliseconds(value: unknown): number {
  const seconds = demandInteger(value);
  requireFact(Number.isSafeInteger(seconds * 1_000), "Bestätigte Haltezeit überschreitet den sicheren Millisekundenbereich.");
  return seconds * 1_000;
}

function texts(value: unknown): readonly string[] {
  requireFact(Array.isArray(value) && value.length <= 256, "Bestätigter Linienbeleg besitzt keine begrenzte Kennungsliste.");
  return value.map(demandText);
}

/** Nur native Zuteilungen mit atomar verarbeiteten SPFV-Belegen werden Angebot.
 * Alle Abfragen sind weltgebunden und benutzen den Welt-/Typ- bzw. Statusindex;
 * Nutzdatenabgleiche lesen höchstens 2000 bestätigte Fahrten pro Revision.
 */
export async function loadCommittedSpfvServices(db: IdentityDatabase, worldId: string,
  baseServices: readonly RecordValue[], window?: { readonly windowStartMs: number; readonly windowEndMs: number }): Promise<CommittedSpfvServices> {
  if (window !== undefined) requireFact(demandInteger(window.windowStartMs) < demandInteger(window.windowEndMs), "Nachfragefenster ist leer oder rückläufig.");
  const [row] = await db.select({ sequence: domainEvents.sequence, payload: domainEvents.payload }).from(domainEvents)
    .where(and(eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, "planning.runtime-state")))
    .orderBy(desc(domainEvents.sequence)).limit(1);
  if (row === undefined) return { services: [], provenance: { kind: "forecast", planningRevision: null, planningStateHash: null, referenceTrainIds: [] } };
  const event = demandRecord(row.payload), state = demandRecord(event["state"]), projection = demandRecord(state["projection"]);
  const revision = demandInteger(event["projectionRevision"]), stateHash = demandText(event["stateHash"]);
  requireFact(event["schemaVersion"] === "planning-runtime-state-event/v1" && event["worldId"] === worldId
    && state["schemaVersion"] === "zugfolge-planning-runtime-state/v1" && state["worldId"] === worldId
    && state["projectionRevision"] === revision && projection["worldId"] === worldId && projection["projectionRevision"] === revision
    && /^[a-f0-9]{64}$/.test(stateHash), "Bestätigte Fernverkehrsplanung besitzt eine fremde Welt oder Revision.");
  const key = demandHash({ sequence: row.sequence, revision, stateHash, baseServices, window: window ?? null });
  const cache = caches.get(db) ?? new Map(); caches.set(db, cache);
  const existing = cache.get(worldId);
  if (existing?.key === key) return structuredClone(existing.result);
  const [diagram] = await db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(eq(domainEvents.worldId, worldId),
    eq(domainEvents.eventType, "planning.diagram"), eq(domainEvents.sequence, row.sequence + 1))).limit(1);
  requireFact(diagram !== undefined && demandHash(diagram.payload) === demandHash(projection), "Fernverkehrsplanung besitzt keinen identischen veröffentlichten Fahrplan.");
  const reservations = state["reservations"] === undefined ? {} : demandRecord(state["reservations"]);
  const trainIds = bounded(Object.keys(reservations).filter((trainId) => {
    if (window === undefined) return true;
    const reservation = demandRecord(reservations[trainId]);
    const calls = reservation["passengerStops"] === undefined ? [] : demandList(reservation["passengerStops"]);
    // Legacy records without passenger timing remain subject to the later
    // explicit evidence check when they actually belong to an SPFV receipt.
    if (calls[0] === undefined) return true;
    const departureMs = milliseconds(calls[0]["departureS"]);
    return departureMs >= window.windowStartMs && departureMs < window.windowEndMs;
  }));
  const empty: CommittedSpfvServices = { services: [], provenance: { kind: "forecast", planningRevision: revision, planningStateHash: stateHash, referenceTrainIds: [] } };
  if (trainIds.length === 0) { cache.set(worldId, { key, result: empty }); return empty; }
  const requests = bounded(await db.select().from(simulationCommands).where(and(eq(simulationCommands.worldId, worldId),
    eq(simulationCommands.status, "processed"), eq(simulationCommands.commandType, "planning.path-request"),
    inArray(sql<string>`${simulationCommands.payload}->>'trainId'`, [...trainIds]))).limit(MAX_SERVICES + 1));
  if (requests.length === 0) { cache.set(worldId, { key, result: empty }); return empty; }
  const requestIds = requests.map((request) => request.id);
  const receipts = bounded(await db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(eq(domainEvents.worldId, worldId),
    eq(domainEvents.eventType, "spfv.submitted"), sql`exists (select 1 from jsonb_array_elements_text(${domainEvents.payload}->'submission'->'planningRequestIds') as item(id)
      where ${inArray(sql<string>`item.id`, requestIds)})`)).limit(MAX_SERVICES + 1));
  if (receipts.length === 0) { cache.set(worldId, { key, result: empty }); return empty; }
  const receiptFacts = receipts.map(({ payload }) => demandRecord(payload));
  const [operatorRows, coordinateRows, previewRows] = await Promise.all([
    db.select({ id: operators.id, accountId: operators.foundingAccountId }).from(operators).where(and(eq(operators.worldId, worldId),
      inArray(operators.id, receiptFacts.map((receipt) => demandText(receipt["operatorId"]))))).limit(MAX_SERVICES + 1),
    db.select().from(simulationCommands).where(and(eq(simulationCommands.worldId, worldId),
      inArray(simulationCommands.id, receiptFacts.map((receipt) => demandText(demandRecord(receipt["submission"])["planningCoordinationId"]))))).limit(MAX_SERVICES + 1),
    db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, "spfv.preview"),
      inArray(sql<string>`${domainEvents.payload}->>'previewId'`, receiptFacts.map((receipt) => demandText(receipt["previewId"]))))).limit(MAX_SERVICES + 1),
  ]);
  const owners = new Map(bounded(operatorRows).map((operator) => [operator.id, operator.accountId]));
  const coordinates = new Map(bounded(coordinateRows).map((coordinate) => [coordinate.id, coordinate]));
  const previews = new Map(bounded(previewRows).map(({ payload }) => { const preview = demandRecord(payload); return [demandText(preview["previewId"]), preview] as const; }));
  const result = new Map<string, RecordValue>(), references = new Set<string>();
  for (const receipt of receiptFacts) {
    const submission = demandRecord(receipt["submission"]);
    const operatorId = demandText(receipt["operatorId"]), accountId = demandText(receipt["accountId"]), previewId = demandText(receipt["previewId"]);
    requireFact(receipt["worldId"] === worldId && submission["worldId"] === worldId && submission["operatorId"] === operatorId
      && submission["previewId"] === previewId && submission["lineId"] === receipt["lineId"] && submission["status"] === "submitted",
    "Fernverkehrsbestätigung verletzt Welt- oder Betreiberbindung.");
    requireFact(owners.get(operatorId) === accountId, "Fernverkehrsbestätigung gehört nicht zum gebundenen Konto.");
    const coordinate = coordinates.get(demandText(submission["planningCoordinationId"]));
    if (coordinate?.status !== "processed") continue;
    const ids = texts(submission["planningRequestIds"]), command = demandRecord(coordinate.payload);
    requireFact(coordinate.commandType === "planning.coordinate" && coordinate.requestingAccountId === accountId
      && command["worldId"] === worldId && demandHash(command["requestCommandIds"]) === demandHash(ids)
      && coordinate.resultEventSequence !== null && coordinate.resultEventSequence <= row.sequence + 1,
    "Fernverkehrsbestätigung besitzt keinen passenden verarbeiteten Planungslauf.");
    const preview = previews.get(previewId);
    requireFact(preview !== undefined, "Gepinnte Fernverkehrsvorschau fehlt.");
    const { accountId: pinnedAccount, previewId: pinnedId, ...body } = preview;
    requireFact(pinnedAccount === accountId && pinnedId === previewId && demandHash(body) === previewId && preview["worldId"] === worldId
      && preview["operatorId"] === operatorId && preview["lineId"] === receipt["lineId"]
      && demandHash(preview["draft"]) === demandHash(receipt["draft"]), "Gepinnte Fernverkehrsvorschau ist verändert oder fremd.");
    const draft = demandRecord(preview["draft"]), stopIds = texts(draft["stopIds"]), capacity = demandRecord(preview["capacityFacts"]);
    const reference = [...baseServices].sort((left, right) => {
      const a = demandText(left["trainRunId"]), b = demandText(right["trainRunId"]);
      return a < b ? -1 : a > b ? 1 : 0;
    }).find((service) => {
      if (service["worldId"] !== worldId || (draft["referenceTrainId"] !== undefined && draft["referenceTrainId"] !== service["trainRunId"])) return false;
      const referenceIds = demandList(service["stops"]).map((stop) => stop["stationId"]);
      const indices = stopIds.map((id) => referenceIds.indexOf(id));
      return indices.every((index, position) => index >= 0 && (position === 0 || index > indices[position - 1]!));
    });
    requireFact(reference !== undefined, "Bestätigter Fernverkehr besitzt keine gepinnte Referenzqualität für diese Haltefolge.");
    const fareText = demandText(draft["fareCents"]);
    requireFact(/^(0|[1-9][0-9]{0,18})$/.test(fareText) && BigInt(fareText) <= 1_000_000_000n, "Bestätigter Abschnittspreis ist ungültig.");
    const fare = Number(fareText), headway = demandInteger(draft["headwayS"]), from = demandInteger(draft["validFromS"]), until = demandInteger(draft["validUntilS"]);
    requireFact(headway >= 60 && headway <= 86_400 && from < until, "Bestätigter Takt ist ungültig.");
    for (const request of requests.filter((request) => ids.includes(request.id))) {
      const payload = demandRecord(request.payload), trainId = demandText(payload["trainId"]), reservation = demandRecord(reservations[trainId]);
      requireFact(request.requestingAccountId === accountId && request.resultEventSequence === coordinate.resultEventSequence
        && payload["schemaVersion"] === "planning.path-request/v4" && payload["worldId"] === worldId && payload["operatorId"] === operatorId
        && payload["requestingAccountId"] === accountId
        && payload["formationId"] === draft["formationId"] && payload["fleetStateHash"] === preview["fleetStateHash"]
        && payload["trainCategory"] === "long-distance", "Bestätigte Fahrt besitzt eine fremde Fahrzeug- oder Kontoautorität.");
      const train = demandRecord(reservation["train"]), calls = demandList(reservation["passengerStops"]), window = demandRecord(reservation["serviceWindow"]);
      const departure = demandInteger(payload["desiredDepartureS"]);
      requireFact(train["id"] === trainId && demandHash(calls.map((call) => call["stationId"])) === demandHash(stopIds)
        && departure >= from && departure < until && (departure - from) % headway === 0
        && window["validFromS"] === departure && window["validUntilS"] === departure + 1
        && demandHash(payload["serviceWindow"]) === demandHash(window) && calls[0]?.["departureS"] === departure,
      "Bestätigte Fahrt weicht von Abfahrtsfenster oder Verkehrshalten der Linie ab.");
      const stops = calls.map((call, index) => ({ stopId: `${trainId}:${index}`, stationId: demandText(call["stationId"]),
        arrivalMs: milliseconds(call["arrivalS"]), departureMs: milliseconds(call["departureS"]), passengerStop: true }));
      requireFact(stops.every((stop, index) => stop.departureMs >= stop.arrivalMs && (index === 0 || stop.arrivalMs > stops[index - 1]!.departureMs)),
        "Bestätigte Verkehrshalte besitzen widersprüchliche Zeiten.");
      const service = { worldId, trainRunId: trainId, operatorId, mode: "spfv", cancelled: false, stops,
        fares: ["standard", "premium"].map((comfortClass) => ({ id: `${trainId}:${comfortClass}`, comfortClass, centsPerSegment: fare,
          salesAvailable: true, onboardSales: true, reservationRequired: false })),
        capacity: { standardSeats: demandInteger(capacity["standardSeats"]), premiumSeats: demandInteger(capacity["premiumSeats"]),
          bicycleSpaces: demandInteger(capacity["bicycleSpaces"]), wheelchairSpaces: demandInteger(capacity["wheelchairSpaces"]), standardStanding: 0, strollerSpaces: 0 },
        serviceIntervalMs: milliseconds(headway), reliabilityBasisPoints: demandInteger(reference["reliabilityBasisPoints"]),
        comfortBasisPoints: demandInteger(reference["comfortBasisPoints"]) };
      requireFact(!result.has(trainId), "Bestätigte Fahrt gehört zu mehreren Fernverkehrslinien.");
      result.set(trainId, service); references.add(demandText(reference["trainRunId"]));
    }
  }
  const projected: CommittedSpfvServices = { services: [...result.values()].sort((a, b) => {
    const left = demandText(a["trainRunId"]), right = demandText(b["trainRunId"]);
    return left < right ? -1 : left > right ? 1 : 0;
  }),
    provenance: { kind: "forecast", planningRevision: revision, planningStateHash: stateHash, referenceTrainIds: [...references].sort() } };
  cache.set(worldId, { key, result: structuredClone(projected) });
  return projected;
}
