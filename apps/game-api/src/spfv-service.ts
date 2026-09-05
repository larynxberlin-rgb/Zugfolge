import { domainEvents, operators, simulationCommands, worlds } from "@zugfolge/db";
import { loadFleetProducerCheckpoint, type EconomyDatabase, type FleetProducerCheckpoint } from "@zugfolge/economy";
import { PLANNING_PLAYER_PATH_REQUEST_SCHEMA, PLANNING_COORDINATE_BATCH_AUTHORITY_SCHEMA, queuePlanningPathRequest, queuePlanningCoordinate, type PlanningInfrastructureRelease } from "@zugfolge/planning-worker";
import type { FleetRuntime } from "@zugfolge/runtime-native";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { appendDemandEvent, demandHash, DemandError } from "./demand-store.js";
import { resolveAuthoritativePlanningPathRequest } from "./planning-authority.js";

export interface SpfvDraft {
  readonly lineId?: string;
  readonly name: string;
  readonly stopIds: readonly string[];
  readonly headwayS: number;
  readonly fareCents: string;
  readonly formationId: string;
  readonly validFromS: number;
  readonly validUntilS: number;
  readonly referenceTrainId?: string;
}

export interface SpfvScope {
  readonly worldId: string;
  readonly operatorId: string;
  readonly accountId: string;
}

export interface SpfvEstimateInput {
  readonly worldId: string;
  readonly operatorId: string;
  readonly atS: number;
  readonly draft: SpfvDraft;
  readonly capacity: number;
  readonly operatingCostCentsPerTrainKm: number;
  readonly firstClassSeats: number;
  readonly bicyclePlaces: number;
  readonly wheelchairPlaces: number;
  readonly routeDistanceMm: number;
  readonly fleetRevision: number;
  readonly fleetStateHash: string;
  readonly infrastructureReleaseId: string;
  readonly replaceTrainIds?: readonly string[];
}

export interface SpfvEstimate {
  readonly source: Readonly<Record<string, unknown>>;
  readonly requested: number | null;
  readonly served: number | null;
  readonly unserved: number | null;
  readonly fareRevenueCents: string | null;
  readonly costsCents: string | null;
  readonly conflicts: readonly string[];
  readonly connectionEffects: readonly string[];
}

export interface SpfvServiceDependencies {
  readonly db: EconomyDatabase;
  readonly fleetRuntime?: Pick<FleetRuntime, "verifyFleetWorldState">;
  readonly infrastructureReleaseForWorld: (worldId: string) => PlanningInfrastructureRelease | undefined;
  readonly timeForWorld: (worldId: string) => Promise<number>;
  readonly estimate: (input: SpfvEstimateInput) => Promise<SpfvEstimate>;
}

export interface SpfvReplacementTrip {
  readonly trainId: string;
  readonly trainNumber: number;
  readonly departureS: number;
  readonly originLabel: string | null;
  readonly destinationLabel: string | null;
}

export interface SpfvPreview extends Omit<SpfvEstimate, "source"> {
  readonly source: "forecast" | "observed" | "assumption";
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly schemaVersion: "zugfolge-spfv-preview/v1";
  readonly schema: "zugfolge-spfv-preview/v1";
  readonly worldId: string;
  readonly operatorId: string;
  readonly previewId: string;
  readonly lineId: string;
  readonly name: string;
  readonly capacity: number;
  readonly asOfS: number;
  readonly capacityFacts: { readonly standardSeats: number; readonly premiumSeats: number; readonly bicycleSpaces: number; readonly wheelchairSpaces: number };
  readonly replacementTrainIds: readonly string[];
  readonly replacementTrips: readonly SpfvReplacementTrip[];
  readonly releaseId: string;
  readonly requestedPassengers: number | null;
  readonly servedPassengers: number | null;
  readonly unservedPassengers: number | null;
  readonly atS: number;
  readonly expiresAtS: number;
  readonly draft: SpfvDraft;
  readonly infrastructureReleaseId: string;
  readonly infrastructureHash: string;
  readonly fleetRevision: number;
  readonly fleetStateHash: string;
  readonly planningRequestCount: number;
  readonly planningStatus: "not-yet-allocated";
  readonly confirmationAllowed: boolean;
}

export interface SpfvSubmission {
  readonly worldId: string;
  readonly operatorId: string;
  readonly lineId: string;
  readonly previewId: string;
  readonly status: "submitted";
  readonly planningRequestIds: readonly string[];
  readonly planningCoordinationId: string;
}

const MAX_DEPARTURES = 256;
const PREVIEW_TTL_S = 300;
const MINIMUM_DWELL_S = 60;

function valid(condition: unknown, message: string, statusCode = 400): asserts condition {
  if (!condition) throw new DemandError(statusCode, message);
}

function text(value: unknown, name: string, maximum = 160): asserts value is string {
  valid(typeof value === "string" && value.trim().length > 0 && value.length <= maximum, `${name} fehlt oder ist zu lang.`);
}

/** Spieler liefern Absichten; Kapazität, Physik, Nummern und Erlöse sind keine Eingabefelder. */
export function parseSpfvDraft(value: unknown): SpfvDraft {
  valid(value !== null && typeof value === "object" && !Array.isArray(value), "Fernverkehrslinie fehlt.");
  const draft = value as Record<string, unknown>;
  const keys = ["lineId", "name", "stopIds", "headwayS", "fareCents", "formationId", "validFromS", "validUntilS", "referenceTrainId"];
  valid(Object.keys(draft).every((key) => keys.includes(key)), "Fernverkehrslinie enthält unbekannte Felder.");
  text(draft["name"], "Linienname");
  text(draft["formationId"], "Formation");
  if (draft["lineId"] !== undefined) text(draft["lineId"], "Linienkennung");
  if (draft["referenceTrainId"] !== undefined) text(draft["referenceTrainId"], "Referenzfahrt");
  const stopIds = draft["stopIds"];
  valid(Array.isArray(stopIds) && stopIds.length >= 2 && stopIds.length <= 64, "Zwei bis 64 Halte sind erforderlich.");
  stopIds.forEach((id) => text(id, "Halt"));
  valid(new Set(stopIds).size === stopIds.length, "Ein Halt darf in diesem Linienlauf nur einmal vorkommen.");
  const headwayS = draft["headwayS"];
  const from = draft["validFromS"];
  const until = draft["validUntilS"];
  valid(Number.isSafeInteger(headwayS) && (headwayS as number) >= 60 && (headwayS as number) <= 86_400, "Takt muss zwischen 60 und 86400 Sekunden liegen.");
  valid(Number.isSafeInteger(from) && (from as number) >= 0 && Number.isSafeInteger(until) && (until as number) > (from as number), "Betriebszeitfenster ist ungültig.");
  valid(typeof draft["fareCents"] === "string" && /^(0|[1-9][0-9]{0,18})$/.test(draft["fareCents"])
    && BigInt(draft["fareCents"]) <= 1_000_000_000n, "Fahrpreis muss zwischen 0 und 1000000000 Cent liegen.");
  valid(BigInt(until as number) - BigInt(from as number) <= BigInt(headwayS as number) * BigInt(MAX_DEPARTURES), "Die Linie überschreitet 256 Trassenanträge pro Vorschau.");
  return { ...(draft["lineId"] === undefined ? {} : { lineId: draft["lineId"] as string }), name: draft["name"] as string,
    stopIds: [...stopIds] as string[], headwayS: headwayS as number, fareCents: draft["fareCents"],
    formationId: draft["formationId"] as string, validFromS: from as number, validUntilS: until as number,
    ...(draft["referenceTrainId"] === undefined ? {} : { referenceTrainId: draft["referenceTrainId"] as string }) };
}

function departures(draft: SpfvDraft): readonly number[] {
  const result: number[] = [];
  for (let at = BigInt(draft.validFromS); at < BigInt(draft.validUntilS); at += BigInt(draft.headwayS)) result.push(Number(at));
  return result;
}

function previewHash(preview: Omit<SpfvPreview, "previewId">): string { return demandHash(preview); }

/** Schmale Plattformgrenze: Nachfrage kommt aus Rust, Trassen werden ausschließlich beim bestehenden Planner beantragt. */
export class SpfvService {
  constructor(private readonly deps: SpfvServiceDependencies) {}

  private async owner(db: EconomyDatabase, scope: SpfvScope) {
    const [world] = await db.select().from(worlds).where(eq(worlds.id, scope.worldId)).limit(1);
    valid(world !== undefined && world.lifecycleStatus === "active", "Spielwelt ist nicht aktiv.", 409);
    const [operator] = await db.select({ id: operators.id }).from(operators).where(and(eq(operators.worldId, scope.worldId),
      eq(operators.id, scope.operatorId), eq(operators.foundingAccountId, scope.accountId), eq(operators.lifecycle, "active"))).limit(1);
    valid(operator !== undefined, "Dieses Unternehmen gehört nicht zum aktiven Konto.", 403);
    return world;
  }

  private release(worldId: string) {
    const release = this.deps.infrastructureReleaseForWorld(worldId);
    valid(release !== undefined && release.worldId === worldId, "Freigegebene Planungsinfrastruktur fehlt.", 503);
    return release;
  }

  private async fleet(db: EconomyDatabase, scope: SpfvScope): Promise<FleetProducerCheckpoint> {
    const checkpoint = await loadFleetProducerCheckpoint(db, scope.worldId);
    valid(checkpoint !== undefined && checkpoint.state.worldId === scope.worldId, "Autoritativer Flottenstand fehlt.", 503);
    valid(this.deps.fleetRuntime !== undefined, "Native Flottenprüfung ist nicht verfügbar.", 503);
    const proof = this.deps.fleetRuntime.verifyFleetWorldState(checkpoint.state, checkpoint.stateHash);
    valid(proof.worldId === scope.worldId && proof.revision === checkpoint.state.revision
      && proof.producedAt === checkpoint.state.producedAt && proof.stateHash === checkpoint.stateHash
      && proof.authorityReleaseHash === checkpoint.state.authorityReleaseHash && proof.snapshotHash === checkpoint.snapshotHash,
    "Flottenprüfung bindet den gespeicherten Stand nicht.", 503);
    return checkpoint;
  }

  async catalog(scope: SpfvScope) {
    const world = await this.owner(this.deps.db, scope);
    const release = this.release(scope.worldId);
    const checkpoint = await this.fleet(this.deps.db, scope);
    const atS = await this.deps.timeForWorld(scope.worldId);
    valid(Number.isSafeInteger(atS) && atS >= 0, "Simulationszeit ist ungültig.", 503);
    const periodDurationS = world.schedulePeriodWeeks * 7 * 86_400;
    const periodStartS = Number(BigInt(atS) / BigInt(periodDurationS) * BigInt(periodDurationS));
    const rows = await this.deps.db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(
      eq(domainEvents.worldId, scope.worldId), eq(domainEvents.eventType, "spfv.submitted"),
      sql`${domainEvents.payload}->>'operatorId' = ${scope.operatorId}`, sql`${domainEvents.payload}->>'accountId' = ${scope.accountId}`)).orderBy(desc(domainEvents.sequence)).limit(256);
    const latestLines = new Map<string, SpfvDraft>();
    const assets = new Map(checkpoint.state.authorityRelease.assets.map((asset) => [asset.id, asset]));
    for (const { payload } of rows) {
      const row = payload as { lineId: string; draft: SpfvDraft };
      if (!latestLines.has(row.lineId)) latestLines.set(row.lineId, row.draft);
    }
    return { schemaVersion: "zugfolge-spfv-catalog/v1" as const, schema: "zugfolge-spfv-catalog/v1" as const, worldId: scope.worldId, operatorId: scope.operatorId,
      periodId: `period-${BigInt(atS) / BigInt(periodDurationS)}`, periodStartS, periodEndS: periodStartS + periodDurationS,
      asOfS: atS, releaseId: release.releaseId, defaultHeadwayS: 3_600,
      source: { kind: "committed", infrastructureReleaseId: release.releaseId, sourceId: release.sourceId, fleetRevision: checkpoint.state.revision },
      stops: release.stations.map(({ id, name }) => ({ id, label: name })),
      formations: checkpoint.snapshot.formations.filter((formation) => formation.operatorId === scope.operatorId
        && formation.availability === "available" && formation.procurement === "delivered")
        .map((formation) => {
          const vehicles = checkpoint.state.formations[formation.id]?.vehicleIds;
          valid(vehicles !== undefined, "Flottenprojektion besitzt keine gebundene Formation.", 503);
          const firstClassSeats = vehicles.reduce((sum, id) => {
            const asset = assets.get(id);
            valid(asset !== undefined, "Flottenprojektion besitzt ein unbekanntes Fahrzeug.", 503);
            return sum + asset.passenger.firstClassSeats;
          }, 0);
          return { id: formation.id, label: formation.id, seats: formation.characteristics.seats, firstClassSeats,
          bicyclePlaces: formation.characteristics.bicyclePlaces, wheelchairPlaces: formation.characteristics.wheelchairPlaces,
          availableFromS: formation.availableFrom, availableUntilS: formation.availableUntil }; }),
      lines: [...latestLines].map(([id, draft]) => ({ ...draft, lineId: id, id })),
      limits: { minimumHeadwayS: 60, maximumHeadwayS: 86_400, maximumDepartures: MAX_DEPARTURES,
        periodDurationS } };
  }

  private async evaluate(db: EconomyDatabase, scope: SpfvScope, draft: SpfvDraft, atS: number) {
    const world = await this.owner(db, scope);
    valid(Number.isSafeInteger(atS) && atS >= 0 && draft.validFromS > atS, "Erste Abfahrt muss nach der aktuellen Simulationszeit liegen.", 409);
    const periodS = world.schedulePeriodWeeks * 7 * 86_400;
    valid(BigInt(draft.validFromS) / BigInt(periodS) === BigInt(draft.validUntilS - 1) / BigInt(periodS), "Die Linie darf keinen Fahrplanperiodenwechsel überspannen.", 409);
    const release = this.release(scope.worldId);
    const indices = draft.stopIds.map((id) => release.stations.findIndex((station) => station.id === id));
    valid(indices.every((index) => index >= 0), "Ein Halt fehlt im freigegebenen Korridor.", 409);
    const direction = indices[1]! > indices[0]! ? 1 : -1;
    valid(indices.every((index, position) => position === 0 || (index - indices[position - 1]!) * direction > 0), "Halte müssen in Laufwegreihenfolge liegen.", 409);
    const low = Math.min(indices[0]!, indices.at(-1)!);
    const high = Math.max(indices[0]!, indices.at(-1)!);
    let distance = 0n;
    for (let index = low; index < high; index += 1) {
      const from = release.stations[index]!.id;
      const to = release.stations[index + 1]!.id;
      const segments = release.segments.filter((segment) => segment.fromStationId === from && segment.toStationId === to);
      valid(segments.length === 1, "Freigegebener Korridor ist nicht eindeutig verbunden.", 409);
      distance += BigInt(segments[0]!.lengthMm);
    }
    valid(distance > 0n && distance <= BigInt(Number.MAX_SAFE_INTEGER), "Laufweglänge ist nicht sicher darstellbar.", 503);
    const checkpoint = await this.fleet(db, scope);
    const formation = checkpoint.snapshot.formations.find((candidate) => candidate.id === draft.formationId && candidate.operatorId === scope.operatorId);
    valid(formation !== undefined && formation.availability === "available" && formation.procurement === "delivered", "Formation ist nicht verfügbar.", 409);
    valid(formation.availableFrom <= draft.validFromS && formation.availableUntil >= draft.validUntilS, "Formation deckt das Zeitfenster nicht ab.", 409);
    const nativeFormation = checkpoint.state.formations[draft.formationId];
    valid(nativeFormation !== undefined && nativeFormation.vehicleIds.every((id) => checkpoint.state.assetHoldings?.[id]?.holderOperatorId === scope.operatorId), "Formation gehört nicht zu diesem Unternehmen.", 403);
    const capacity = formation.characteristics.seats;
    const assets = new Map(checkpoint.state.authorityRelease.assets.map((asset) => [asset.id, asset] as const));
    let firstClassSeats = 0;
    for (const id of nativeFormation.vehicleIds) {
      const asset = assets.get(id);
      valid(asset !== undefined, "Formation enthält ein unbekanntes Fahrzeug.", 503);
      firstClassSeats += asset.passenger.firstClassSeats;
    }
    valid(Number.isSafeInteger(firstClassSeats) && firstClassSeats <= capacity, "Erstklassplätze sind inkonsistent.", 503);
    const replacementTrips = await this.replacementTrips(db, scope, draft, release);
    const replaceTrainIds = replacementTrips.map((trip) => trip.trainId);
    const estimate = await this.deps.estimate({ worldId: scope.worldId, operatorId: scope.operatorId, atS, draft, capacity, replaceTrainIds,
      operatingCostCentsPerTrainKm: formation.characteristics.operatingCostCentsPerTrainKm,
      firstClassSeats, bicyclePlaces: formation.characteristics.bicyclePlaces, wheelchairPlaces: formation.characteristics.wheelchairPlaces,
      routeDistanceMm: Number(distance), fleetRevision: checkpoint.state.revision, fleetStateHash: checkpoint.stateHash, infrastructureReleaseId: release.releaseId });
    for (const value of [estimate.requested, estimate.served, estimate.unserved]) valid(value === null || Number.isSafeInteger(value) && value >= 0, "Nachfragevorschau enthält ungültige Fahrgastzahlen.", 503);
    for (const value of [estimate.fareRevenueCents, estimate.costsCents]) valid(value === null || /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n, "Nachfragevorschau enthält ungültige Geldwerte.", 503);
    // Weitere Reisende dürfen Bestandszüge oder andere Verkehrsmittel wählen.
    valid(estimate.requested === null || estimate.served === null || estimate.unserved === null || BigInt(estimate.requested) >= BigInt(estimate.served) + BigInt(estimate.unserved), "Nachfragevorschau überschreitet die Fahrgastsumme.", 503);
    return { estimate, capacity, release, checkpoint, world, replaceTrainIds, replacementTrips,
      capacityFacts: { standardSeats: capacity - firstClassSeats, premiumSeats: firstClassSeats,
        bicycleSpaces: formation.characteristics.bicyclePlaces, wheelchairSpaces: formation.characteristics.wheelchairPlaces } };
  }

  async preview(scope: SpfvScope, input: unknown): Promise<SpfvPreview> {
    const draft = parseSpfvDraft(input);
    return this.deps.db.transaction(async (tx) => {
      await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${scope.worldId} for update`);
      const atS = await this.deps.timeForWorld(scope.worldId);
      const { estimate, capacity, capacityFacts, replaceTrainIds, replacementTrips, release, checkpoint, world } = await this.evaluate(tx, scope, draft, atS);
      const lineId = draft.lineId ?? `spfv-${demandHash({ worldId: scope.worldId, operatorId: scope.operatorId, draft }).slice(0, 24)}`;
      const source = estimate.source["source"] === "observed" ? "observed" as const
        : estimate.source["source"] === "assumption" || estimate.source["kind"] === "balanced" ? "assumption" as const : "forecast" as const;
      const body: Omit<SpfvPreview, "previewId"> = { ...estimate, source, provenance: estimate.source,
        schemaVersion: "zugfolge-spfv-preview/v1", schema: "zugfolge-spfv-preview/v1", worldId: scope.worldId,
        asOfS: atS, releaseId: release.releaseId, requestedPassengers: estimate.requested, servedPassengers: estimate.served, unservedPassengers: estimate.unserved,
        operatorId: scope.operatorId, lineId, name: draft.name, capacity, capacityFacts, replacementTrainIds: replaceTrainIds, replacementTrips,
        atS, expiresAtS: Math.min(atS + PREVIEW_TTL_S, draft.validFromS - 1), draft,
        infrastructureReleaseId: release.releaseId, infrastructureHash: demandHash(release), fleetRevision: checkpoint.state.revision,
        fleetStateHash: checkpoint.stateHash, planningRequestCount: departures(draft).length, planningStatus: "not-yet-allocated",
        confirmationAllowed: estimate.conflicts.length === 0 && [estimate.requested, estimate.served, estimate.unserved, estimate.fareRevenueCents, estimate.costsCents].every((value) => value !== null) };
      const preview: SpfvPreview = { ...body, previewId: previewHash(body) };
      const existing = await this.findEvent(tx, scope, "spfv.preview", "previewId", preview.previewId);
      if (existing === undefined) await appendDemandEvent(tx, scope.worldId, "spfv.preview", { ...preview, accountId: scope.accountId }, new Date(world.epoch.getTime() + atS * 1_000));
      return preview;
    });
  }

  private async findEvent(db: EconomyDatabase, scope: SpfvScope, type: string, key: string, value: string) {
    const [event] = await db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(eq(domainEvents.worldId, scope.worldId),
      eq(domainEvents.eventType, type), sql`${domainEvents.payload}->>'operatorId' = ${scope.operatorId}`,
      sql`${domainEvents.payload}->>'accountId' = ${scope.accountId}`, sql`${domainEvents.payload}->>${key} = ${value}`)).orderBy(desc(domainEvents.sequence)).limit(1);
    return event?.payload as Record<string, unknown> | undefined;
  }

  private async replacementTrips(db: EconomyDatabase, scope: SpfvScope, draft: SpfvDraft, release: PlanningInfrastructureRelease): Promise<readonly SpfvReplacementTrip[]> {
    if (draft.lineId === undefined) return [];
    const [stateRow] = await db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(
      eq(domainEvents.worldId, scope.worldId), eq(domainEvents.eventType, "planning.runtime-state"))).orderBy(desc(domainEvents.sequence)).limit(1);
    const state = stateRow?.payload as { state: { reservations?: Record<string, unknown> } } | undefined;
    const histories = await db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(
      eq(domainEvents.worldId, scope.worldId), eq(domainEvents.eventType, "spfv.submitted"),
      sql`${domainEvents.payload}->>'operatorId' = ${scope.operatorId}`, sql`${domainEvents.payload}->>'accountId' = ${scope.accountId}`,
      sql`${domainEvents.payload}->>'lineId' = ${draft.lineId}`));
    const ownedIds = new Set(histories.flatMap(({ payload }) => ((payload as { submission: SpfvSubmission }).submission.planningRequestIds)));
    if (ownedIds.size === 0) return [];
    const requests = await db.select({ payload: simulationCommands.payload }).from(simulationCommands).where(and(
      eq(simulationCommands.worldId, scope.worldId), eq(simulationCommands.requestingAccountId, scope.accountId),
      eq(simulationCommands.commandType, "planning.path-request"), eq(simulationCommands.status, "processed"),
      inArray(simulationCommands.id, [...ownedIds])));
    const trips = new Map<string, SpfvReplacementTrip>();
    for (const { payload } of requests) {
      const request = payload as { trainId: string; trainNumber: number; operatorId: string; desiredDepartureS: number };
      if (request.operatorId !== scope.operatorId || request.desiredDepartureS < draft.validFromS
        || !Object.hasOwn(state?.state.reservations ?? {}, request.trainId)) continue;
      const reservation = state!.state.reservations![request.trainId] as {
        number?: number; passengerStops?: readonly { stationId: string; departureS: number }[];
      } | undefined;
      const stops = reservation?.passengerStops;
      const first = stops?.[0], last = stops?.at(-1);
      valid(reservation !== undefined && Number.isSafeInteger(reservation.number) && reservation.number! > 0
        && reservation.number === request.trainNumber && first !== undefined && last !== undefined && stops!.length >= 2
        && typeof first.stationId === "string" && typeof last.stationId === "string"
        && Number.isSafeInteger(first.departureS) && first.departureS >= draft.validFromS,
      "Betroffene Fahrt besitzt keine belegte Zugnummer oder Abfahrtszeit.", 503);
      trips.set(request.trainId, { trainId: request.trainId, trainNumber: reservation.number!, departureS: first.departureS,
        originLabel: release.stations.find((station) => station.id === first.stationId)?.name ?? null,
        destinationLabel: release.stations.find((station) => station.id === last.stationId)?.name ?? null });
    }
    valid(trips.size <= MAX_DEPARTURES, "Die Änderung betrifft zu viele Fahrten für eine gemeinsame Vorschau.", 409);
    return [...trips.values()].sort((a, b) => a.trainId < b.trainId ? -1 : a.trainId > b.trainId ? 1 : 0);
  }

  async confirm(scope: SpfvScope, input: { readonly previewId: string; readonly commandId: string }): Promise<SpfvSubmission> {
    text(input.previewId, "Vorschaukennung"); text(input.commandId, "Kommandokennung");
    return this.deps.db.transaction(async (tx) => {
      await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${scope.worldId} for update`);
      const world = await this.owner(tx, scope);
      const idempotencyKey = `spfv-confirm:${input.commandId}`;
      const [replay] = await tx.select().from(simulationCommands).where(and(eq(simulationCommands.worldId, scope.worldId),
        eq(simulationCommands.requestingAccountId, scope.accountId), eq(simulationCommands.idempotencyKey, idempotencyKey))).limit(1);
      if (replay !== undefined) {
        const receipt = replay.payload as SpfvSubmission;
        valid(replay.commandType === "spfv.confirm" && receipt.previewId === input.previewId && receipt.operatorId === scope.operatorId,
          "Kommandokennung ist bereits anders belegt.", 409);
        return receipt;
      }
      const previous = await this.findEvent(tx, scope, "spfv.submitted", "previewId", input.previewId);
      let result: SpfvSubmission;
      const atS = await this.deps.timeForWorld(scope.worldId);
      const occurredAt = new Date(world.epoch.getTime() + atS * 1_000);
      if (previous !== undefined) {
        result = previous["submission"] as SpfvSubmission;
      } else {
        const stored = await this.findEvent(tx, scope, "spfv.preview", "previewId", input.previewId);
        valid(stored !== undefined, "Vorschau wurde für dieses Unternehmen nicht gefunden.", 404);
        const { accountId: _accountId, previewId: _previewId, ...body } = stored;
        valid(previewHash(body as unknown as Omit<SpfvPreview, "previewId">) === input.previewId, "Gespeicherte Vorschau ist nicht unverändert.", 503);
        const preview = stored as unknown as SpfvPreview;
        valid(preview.confirmationAllowed && atS >= preview.atS && atS <= preview.expiresAtS, "Vorschau ist veraltet oder nicht bestätigbar.", 409);
        const current = await this.evaluate(tx, scope, parseSpfvDraft(preview.draft), atS);
        valid(demandHash(current.replaceTrainIds) === demandHash(preview.replacementTrainIds)
          && demandHash(current.replacementTrips) === demandHash(preview.replacementTrips), "Trassenzuordnung wurde seit der Vorschau geändert.", 409);
        valid(current.checkpoint.stateHash === preview.fleetStateHash && demandHash(current.release) === preview.infrastructureHash,
          "Flotte oder Infrastruktur wurden seit der Vorschau geändert.", 409);
        valid(demandHash(current.estimate) === demandHash({ source: preview.provenance, requested: preview.requested, served: preview.served,
          unserved: preview.unserved, fareRevenueCents: preview.fareRevenueCents, costsCents: preview.costsCents,
          conflicts: preview.conflicts, connectionEffects: preview.connectionEffects }), "Nachfrage oder Kosten wurden seit der Vorschau geändert.", 409);
        const [pending] = await tx.select({ id: simulationCommands.id }).from(simulationCommands).where(and(
          eq(simulationCommands.worldId, scope.worldId), eq(simulationCommands.status, "pending"),
          inArray(simulationCommands.commandType, ["planning.coordinate", "planning.apply-alternative"]))).limit(1);
        valid(pending === undefined, "Eine Trassenkoordinierung läuft bereits. Bitte nach ihrem Abschluss erneut bestätigen.", 409);
        const [stateEvent] = await tx.select({ payload: domainEvents.payload }).from(domainEvents).where(and(
          eq(domainEvents.worldId, scope.worldId), eq(domainEvents.eventType, "planning.runtime-state"))).orderBy(desc(domainEvents.sequence)).limit(1);
        const state = stateEvent?.payload as { projectionRevision: number; state: { infrastructureHash?: string; reservations?: Record<string, unknown> } } | undefined;
        valid(state === undefined || state.state.infrastructureHash !== undefined,
          "Der bestehende Planungsstand braucht eine Koordinierung mit gespeicherten Trassenbelegungen.", 409);
        const replaceTrainIds = current.replaceTrainIds;
        const requestIds: string[] = [];
        for (const [index, departureS] of departures(preview.draft).entries()) {
          const requestId = `spfv-${demandHash({ operatorId: scope.operatorId, previewId: preview.previewId, index }).slice(0, 48)}`;
          const authoritative = await resolveAuthoritativePlanningPathRequest(tx, { worldId: scope.worldId, accountId: scope.accountId,
            fleetRuntime: this.deps.fleetRuntime, body: { schemaVersion: PLANNING_PLAYER_PATH_REQUEST_SCHEMA, requestId,
              formationId: preview.draft.formationId, trainCategory: "long-distance", originStationId: preview.draft.stopIds[0]!,
              destinationStationId: preview.draft.stopIds.at(-1)!, desiredDepartureS: departureS, operatingDays: "daily",
              serviceWindow: { validFromS: departureS, validUntilS: departureS + 1 },
              stops: preview.draft.stopIds.slice(1, -1).map((stationId) => ({ stationId, minimumDwellS: MINIMUM_DWELL_S })),
              earlierS: 0, laterS: 0, stepS: 1, extraRunningTimeS: 0, maxOperationalStops: 0 } });
          valid(authoritative.operatorId === scope.operatorId && authoritative.fleetStateHash === preview.fleetStateHash, "Trassenautorität hat eine fremde Formation gebunden.", 409);
          const command = await queuePlanningPathRequest(tx, { worldId: scope.worldId, requestingAccountId: scope.accountId,
            body: authoritative, submittedAt: occurredAt });
          requestIds.push(command.id);
        }
        const coordinate = await queuePlanningCoordinate(tx, { worldId: scope.worldId, authorityAccountId: scope.accountId,
          submittedAt: occurredAt, body: { schemaVersion: PLANNING_COORDINATE_BATCH_AUTHORITY_SCHEMA,
            runId: `spfv-${preview.previewId}`, expectedProjectionRevision: state?.projectionRevision ?? null,
            seedWorld: BigInt(`0x${demandHash({ worldId: scope.worldId }).slice(0, 16)}`).toString(),
            seedPeriod: Math.trunc(preview.draft.validFromS / (world.schedulePeriodWeeks * 7 * 86_400)),
            infrastructureReleaseId: preview.infrastructureReleaseId, requestCommandIds: requestIds,
            ...(replaceTrainIds.length === 0 ? {} : { replaceTrainIds: [...new Set(replaceTrainIds)].sort(), effectiveFromS: atS }) } });
        result = { worldId: scope.worldId, operatorId: scope.operatorId, lineId: preview.lineId, previewId: input.previewId,
          status: "submitted", planningRequestIds: requestIds, planningCoordinationId: coordinate.id };
        await appendDemandEvent(tx, scope.worldId, "spfv.submitted", { worldId: scope.worldId, operatorId: scope.operatorId,
          accountId: scope.accountId, lineId: preview.lineId, previewId: input.previewId, draft: preview.draft, submission: result }, occurredAt);
      }
      await tx.insert(simulationCommands).values({ worldId: scope.worldId, requestingAccountId: scope.accountId,
        idempotencyKey, commandType: "spfv.confirm", payload: result, status: "processed", submittedAt: occurredAt, processedAt: occurredAt });
      return result;
    });
  }
}
