import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { DemandRuntime } from "@zugfolge/runtime-native";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { LivemapReadModel, LivemapRegistry } from "@zugfolge/livemap-stream";
import type { PlanningInfrastructureRelease } from "@zugfolge/planning-worker";
import { DemandError, DemandStore, demandHash, demandInteger, demandList, demandRecord, demandText, type DemandCheckpoint } from "./demand-store.js";
import type { SpfvEstimate, SpfvEstimateInput } from "./spfv-service.js";
import { loadCommittedSpfvServices } from "./spfv-demand-projection.js";

export interface DemandDeployment {
  readonly schemaVersion: "zugfolge-demand-deployment/v1";
  readonly worldId: string;
  readonly infrastructureReleaseId: string;
  readonly windows: readonly Readonly<Record<string, unknown>>[];
}

/** Lokaler freigegebener Datenkorpus; der Dateipin stammt aus der Serverkonfiguration. */
export async function loadDemandDeployment(path: string, expectedSha256: string, worldId: string): Promise<{ deployment: DemandDeployment; hash: string }> {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new DemandError(503, "Nachfragepfad oder Releasepin fehlt.");
  if ((await stat(path)).size > 16 * 1024 * 1024) throw new DemandError(503, "Nachfragekorpus ist zu groß.");
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new DemandError(503, "Nachfragekorpus stimmt nicht mit dem freigegebenen Pin überein.");
  const deployment = demandRecord(JSON.parse(bytes.toString("utf8"))) as unknown as DemandDeployment;
  if (deployment.schemaVersion !== "zugfolge-demand-deployment/v1" || deployment.worldId !== worldId
    || !Array.isArray(deployment.windows) || deployment.windows.length === 0 || deployment.windows.length > 256) throw new DemandError(503, "Nachfragekorpus besitzt keine gültige Welt- und Fensterbindung.");
  demandText(deployment.infrastructureReleaseId);
  let previousEnd = -1;
  const releaseByPeriod = new Map<string, string>();
  for (const input of deployment.windows) {
    if (input["worldId"] !== worldId || input["schemaVersion"] !== "zugfolge-demand-evaluation/v1") throw new DemandError(503, "Fremdes Nachfragefenster im Korpus.");
    const start = demandInteger(input["windowStartMs"]), end = demandInteger(input["windowEndMs"]);
    if (start < previousEnd || start >= end) throw new DemandError(503, "Nachfragefenster überlappen oder sind unsortiert.");
    previousEnd = end;
    const periodId = demandText(input["periodId"]), releaseHash = demandHash(input["release"]);
    if (releaseByPeriod.has(periodId) && releaseByPeriod.get(periodId) !== releaseHash) throw new DemandError(503, "Ein Nachfragezeitraum besitzt mehrere Releasepins.");
    releaseByPeriod.set(periodId, releaseHash);
  }
  return { deployment, hash: expectedSha256 };
}

export interface DemandServiceDependencies {
  readonly db: IdentityDatabase;
  readonly runtime: DemandRuntime;
  readonly deployment: DemandDeployment;
  readonly deploymentHash: string;
  readonly readModel?: LivemapReadModel;
  readonly livemap?: LivemapRegistry;
  readonly infrastructure: readonly PlanningInfrastructureRelease[];
}

/** Ein gemeinsamer Kapazitätspool je gepinnter Periode, auch über Tagesgangscheiben hinweg. */
export function poolDemandWindows(windows: DemandDeployment["windows"]): DemandDeployment["windows"] {
  const periods = new Map<string, Readonly<Record<string, unknown>>[]>();
  for (const window of windows) {
    const key = demandText(window["periodId"]);
    const values = periods.get(key) ?? [];
    values.push(window); periods.set(key, values);
  }
  return [...periods.values()].map((values) => {
    const first = values[0]!;
    const binding = demandHash({ worldId: first["worldId"], periodId: first["periodId"], seed: first["seed"], release: first["release"] });
    const union = (field: "services" | "alternatives", key: string) => {
      const records = new Map<string, Record<string, unknown>>();
      for (const value of values) for (const record of demandList(value[field])) {
        const id = demandText(record[key]);
        if (records.has(id) && demandHash(records.get(id)) !== demandHash(record)) throw new DemandError(503, "Eine Fahrt besitzt im Nachfragepool widersprüchliche Fakten.");
        records.set(id, record);
      }
      return [...records.values()];
    };
    for (const value of values) {
      if (demandHash({ worldId: value["worldId"], periodId: value["periodId"], seed: value["seed"], release: value["release"] }) !== binding)
        throw new DemandError(503, "Nachfragepool besitzt widersprüchliche Periodenpins.");
      if (value["previousEvaluation"] !== undefined || value["operationalProgress"] !== undefined)
        throw new DemandError(503, "Nachfragerelease darf keine vorgefertigten Betriebsbelege enthalten.");
    }
    if (values.length === 1) return first;
    const generationWindows = values.flatMap((value) => value["generationWindows"] === undefined
      ? [{ windowStartMs: demandInteger(value["windowStartMs"]), windowEndMs: demandInteger(value["windowEndMs"]), daySliceId: demandText(value["daySliceId"]) }]
      : demandList(value["generationWindows"])).sort((a, b) => demandInteger(a["windowStartMs"]) - demandInteger(b["windowStartMs"]));
    return { ...first, daySliceId: "pooled", windowStartMs: generationWindows[0]!["windowStartMs"],
      windowEndMs: generationWindows.at(-1)!["windowEndMs"], generationWindows, services: union("services", "trainRunId"), alternatives: union("alternatives", "id") };
  });
}

function demandHorizon(input: Readonly<Record<string, unknown>>, services = demandList(input["services"])): number {
  let horizon = demandInteger(input["windowEndMs"]);
  for (const service of services) for (const stop of demandList(service["stops"]))
    horizon = Math.max(horizon, demandInteger(stop["departureMs"]));
  return horizon;
}

export class DemandService {
  readonly store: DemandStore;
  private activeCycle: Promise<void> | undefined;
  private lastInputHash: string | undefined;
  private available = false;
  private failure = "Nachfrage wartet auf den ersten bestätigten Betriebsstand.";
  private currentMs = 0;
  private readonly verifiedWindows = new Set<Readonly<Record<string, unknown>>>();
  private readonly pools: DemandDeployment["windows"];
  private readonly stations: Map<string, { id: string; name: string; longitudeE7: number; latitudeE7: number }>;

  constructor(private readonly deps: DemandServiceDependencies) {
    this.store = new DemandStore(deps.db, deps.runtime);
    this.pools = poolDemandWindows(deps.deployment.windows);
    for (let index = 1; index < this.pools.length; index += 1) {
      if (demandInteger(this.pools[index]!["windowStartMs"]) < demandHorizon(this.pools[index - 1]!))
        throw new DemandError(503, "Fahrten verschiedener Nachfragereleases überlappen am Periodenwechsel; ein gemeinsamer Übergangsbeleg fehlt.");
    }
    this.stations = new Map(deps.infrastructure.filter((release) => release.worldId === deps.deployment.worldId)
      .flatMap((release) => release.stations).map((station) => [station.id, station]));
  }

  private assertWorld(worldId: string): void {
    if (worldId !== this.deps.deployment.worldId) throw new DemandError(404, "Für diese Welt liegen keine Nachfragedaten vor.");
  }

  /** Einzelner Plattformtakt; unveränderte Betriebslage erzeugt keine weiteren Checkpoints. */
  refresh(nowMs: number, occurredAt: Date): Promise<void> {
    if (this.activeCycle !== undefined) return this.activeCycle;
    const cycle = this.refreshOnce(nowMs, occurredAt).catch((error: unknown) => {
      this.available = false;
      this.failure = error instanceof DemandError ? error.message : "Nachfrage ist nicht verfügbar.";
      throw error;
    }).finally(() => { this.activeCycle = undefined; });
    this.activeCycle = cycle;
    return cycle;
  }

  private async refreshOnce(nowMs: number, occurredAt: Date): Promise<void> {
    demandInteger(nowMs);
    this.currentMs = nowMs;
    const { deployment, readModel, livemap } = this.deps;
    const config = await readModel?.getConfig(deployment.worldId);
    if (config?.infrastructureReleaseId !== deployment.infrastructureReleaseId) throw new DemandError(503, "Nachfrage und aktive Spielkarte verwenden unterschiedliche Infrastruktur.");
    const snapshot = livemap?.initializedWorld(deployment.worldId)?.snapshot();
    if (snapshot === undefined) throw new DemandError(503, "Bestätigter Betriebsstand für Nachfrage fehlt.");
    const live = new Map(snapshot.trains.map((train) => [train.id, train]));
    const previous = await this.store.latest(deployment.worldId);
    if (previous !== undefined && nowMs < demandInteger(previous.input["nowMs"]))
      throw new DemandError(409, "Nachfragezeit darf nicht hinter den gespeicherten Betriebsstand zurückgehen.");
    const previousIndex = previous === undefined ? -1 : this.pools.findIndex((pool) => pool["periodId"] === previous.input["periodId"]);
    let selected: { template: Readonly<Record<string, unknown>>; services: readonly Record<string, unknown>[];
      provenance: Readonly<Record<string, unknown>> } | undefined;
    // Ein bereits begonnener Release bleibt bis zum wirksamen Fahrtende gepinnt.
    // Bei Kaltstart werden höchstens 256 zeitlich begrenzte Pools geprüft; nach
    // Restore beginnen wir beim gespeicherten Pool und öffnen ältere nicht neu.
    for (const template of this.pools.slice(Math.max(0, previousIndex))) {
      if (demandInteger(template["windowStartMs"]) > nowMs) break;
      const baseServices = demandList(template["services"]);
      const accepted = await loadCommittedSpfvServices(this.deps.db, deployment.worldId, baseServices,
        { windowStartMs: demandInteger(template["windowStartMs"]), windowEndMs: demandInteger(template["windowEndMs"]) });
      const previousServices = previous !== undefined && previous.input["periodId"] === template["periodId"]
        ? new Map(demandList(previous.input["services"]).map((service) => [service["trainRunId"], service])) : new Map();
      const allServices = new Map(baseServices.map((service) => [service["trainRunId"], service]));
      for (const service of accepted.services) {
        const departure = demandInteger(demandList(service["stops"])[0]?.["departureMs"]);
        if (departure < demandInteger(template["windowStartMs"]) || departure >= demandInteger(template["windowEndMs"])) continue;
        if (allServices.has(service["trainRunId"])) throw new DemandError(503, "Bestätigte Fernverkehrsfahrt ist im Nachfragekorpus doppelt.");
        allServices.set(service["trainRunId"], service);
      }
      const services = [...allServices.values()].map((service) => {
        const train = live.get(demandText(service["trainRunId"]));
        if (train === undefined) return previousServices.get(service["trainRunId"]) ?? service;
        if (train.operatorId !== service["operatorId"]) throw new DemandError(503, "Nachfragezug gehört nicht zum bestätigten Betreiber.");
        const delayMs = (train.delaySeconds ?? 0) * 1000;
        return { ...service, cancelled: train.status === "cancelled", stops: demandList(service["stops"]).map((stop) => ({
          ...stop, arrivalMs: demandInteger(stop["arrivalMs"]) + delayMs, departureMs: demandInteger(stop["departureMs"]) + delayMs,
        })) };
      });
      if (nowMs < demandHorizon(template, services)) { selected = { template, services, provenance: accepted.provenance }; break; }
    }
    if (selected === undefined) throw new DemandError(503, "Für diesen Zeitraum ist kein Nachfragerelease freigegeben.");
    const { template, services, provenance } = selected;
    if (!this.verifiedWindows.has(template)) {
      if (readModel?.getScheduledCall === undefined) throw new DemandError(503, "Exakte Fahrplanreferenzen für Nachfrage fehlen.");
      for (const service of demandList(template["services"])) {
        const stops = demandList(service["stops"]);
        for (const [index, stop] of stops.entries()) {
          if (stop["passengerStop"] !== true) continue;
          for (const kind of ["arrival", "departure"] as const) {
            if (kind === "arrival" && index === 0 || kind === "departure" && index === stops.length - 1) continue;
            const time = demandInteger(stop[kind === "arrival" ? "arrivalMs" : "departureMs"]);
            if (time % 1000 !== 0 || await readModel.getScheduledCall(deployment.worldId, demandText(stop["stationId"]),
              demandText(service["trainRunId"]), time / 1000, kind) === undefined) throw new DemandError(503, "Nachfragefahrt, Halt oder Zeit ist nicht im aktiven Fahrplan belegt.");
          }
        }
      }
      this.verifiedWindows.add(template);
    }
    const signature = demandHash({ ...template, services, nowMs: 0, revision: 0 });
    if (signature === this.lastInputHash) { this.available = true; return; }
    if (previous !== undefined && previous.deploymentHash === this.deps.deploymentHash
      && signature === demandHash({ ...previous.input, nowMs: 0, revision: 0 })) {
      this.lastInputHash = signature; this.available = true; return;
    }
    const input = { ...template, services, nowMs, revision: previous === undefined ? 1 : demandInteger(previous.input["revision"]) + 1 };
    await this.store.commit(input, this.deps.deploymentHash, occurredAt, provenance);
    this.lastInputHash = signature;
    this.available = true;
    this.failure = "";
  }

  async checkpoint(worldId: string): Promise<DemandCheckpoint> {
    this.assertWorld(worldId);
    if (!this.available) throw new DemandError(503, this.failure);
    const checkpoint = await this.store.latest(worldId, this.deps.deploymentHash);
    if (checkpoint === undefined) throw new DemandError(503, "Nachfrage wurde noch nicht berechnet.");
    return checkpoint;
  }

  private period(checkpoint: DemandCheckpoint) {
    const result = checkpoint.result;
    return { worldId: checkpoint.worldId, periodId: demandText(result["periodId"]),
      periodStartS: Math.trunc(demandInteger(result["windowStartMs"]) / 1000),
      periodEndS: Math.trunc(demandInteger(result["windowEndMs"]) / 1000),
      asOfS: Math.trunc(demandInteger(result["nowMs"]) / 1000),
      source: demandRecord(checkpoint.input["release"])["provenance"] === "balanced" ? "assumption" as const : "forecast" as const,
      releaseId: demandText(result["demandReleaseId"]),
    };
  }

  private page<T>(items: readonly T[], checkpoint: DemandCheckpoint, cursor?: string, limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new DemandError(400, "Seitengröße muss zwischen 1 und 50 liegen.");
    const revision = demandInteger(checkpoint.result["revision"]);
    let offset = 0;
    if (cursor !== undefined) {
      const match = /^(\d+):(\d+)$/.exec(cursor);
      if (match === null || Number(match[1]) !== revision) throw new DemandError(409, "Nachfrage hat sich geändert. Bitte die erste Seite neu laden.");
      offset = Number(match[2]);
      if (!Number.isSafeInteger(offset) || offset > items.length) throw new DemandError(400, "Ungültige Nachfrageseite.");
    }
    return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? `${revision}:${offset + limit}` : null };
  }

  async overview(worldId: string, cursor?: string, limit?: number) {
    const checkpoint = await this.checkpoint(worldId);
    const flows = demandList(checkpoint.result["stopFlows"]);
    const services = demandList(checkpoint.input["services"]);
    const counts = new Map<string, number>();
    for (const flow of flows) {
      const service = services.find((candidate) => candidate["trainRunId"] === flow["trainRunId"]);
      const stop = service === undefined ? undefined : demandList(service["stops"]).find((candidate) => candidate["stopId"] === flow["stopId"]);
      if (stop !== undefined) counts.set(demandText(stop["stationId"]), (counts.get(demandText(stop["stationId"])) ?? 0) + demandInteger(flow["boarding"]));
    }
    const items = [...counts.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([stationId, servedPassengers]) => {
      const station = this.stations.get(stationId);
      return { stationId, label: station?.name ?? stationId,
        ...(station === undefined ? {} : { longitudeE7: station.longitudeE7, latitudeE7: station.latitudeE7 }),
        requestedPassengers: null, servedPassengers, unservedPassengers: null };
    });
    const cohorts = demandList(checkpoint.result["cohorts"]);
    const choices = demandList(checkpoint.result["choices"]);
    const unserved = demandList(checkpoint.result["unserved"]);
    const zones = demandList(demandRecord(checkpoint.input["release"])["zones"]).map((zone) => {
      const origin = cohorts.filter((cohort) => cohort["originZoneId"] === zone["id"]);
      const ids = new Set(origin.map((cohort) => cohort["cohortId"]));
      return { zoneId: demandText(zone["id"]), label: `Gebiet ${demandText(zone["id"])}`,
        requestedPassengers: origin.reduce((sum, cohort) => sum + demandInteger(cohort["passengers"]), 0),
        servedPassengers: choices.filter((choice) => ids.has(choice["cohortId"]) && choice["alternativeMode"] === null).reduce((sum, choice) => sum + demandInteger(choice["passengers"]), 0),
        alternativePassengers: choices.filter((choice) => ids.has(choice["cohortId"]) && choice["alternativeMode"] !== null).reduce((sum, choice) => sum + demandInteger(choice["passengers"]), 0),
        unservedPassengers: unserved.filter((choice) => ids.has(choice["cohortId"])).reduce((sum, choice) => sum + demandInteger(choice["passengers"]), 0),
      };
    }).sort((a, b) => a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0);
    const length = Math.max(items.length, zones.length);
    const indices = this.page(Array.from({ length }, (_, index) => index), checkpoint, cursor, limit);
    return { schemaVersion: "zugfolge-demand-overview/v1", ...this.period(checkpoint),
      items: indices.items.flatMap((index) => items[index] === undefined ? [] : [items[index]!]),
      zones: indices.items.flatMap((index) => zones[index] === undefined ? [] : [zones[index]!]), nextCursor: indices.nextCursor };
  }

  async train(worldId: string, trainId: string) {
    const checkpoint = await this.checkpoint(worldId);
    const service = demandList(checkpoint.input["services"]).find((item) => item["trainRunId"] === trainId);
    if (service === undefined) throw new DemandError(404, "Für diese Fahrt liegen keine Nachfragedaten vor.");
    const stops = demandList(service["stops"]);
    const allocations = demandList(checkpoint.result["allocations"]).filter((item) => item["trainRunId"] === trainId);
    return { schemaVersion: "zugfolge-train-demand/v1", ...this.period(checkpoint), trainId,
      stops: stops.map((stop) => ({ stationId: demandText(stop["stationId"]), label: this.label(stop["stationId"]),
        arrivalS: Math.trunc(demandInteger(stop["arrivalMs"]) / 1000), departureS: Math.trunc(demandInteger(stop["departureMs"]) / 1000) })),
      segments: stops.slice(0, -1).map((from, index) => {
        const to = stops[index + 1]!;
        const allocation = allocations.find((item) => item["fromStopId"] === from["stopId"] && item["toStopId"] === to["stopId"]);
        return { fromStationId: demandText(from["stationId"]), fromStationLabel: this.label(from["stationId"]),
          toStationId: demandText(to["stationId"]), toStationLabel: this.label(to["stationId"]),
          onboard: allocation === undefined ? null : demandInteger(allocation["passengers"]),
          capacity: allocation === undefined ? null : demandInteger(allocation["capacity"]) };
      }),
    };
  }

  private label(stationId: unknown): string { return this.stations.get(demandText(stationId))?.name ?? demandText(stationId); }

  async manifest(worldId: string, operatorId: string, trainId: string, cursor?: string, limit?: number) {
    const checkpoint = await this.checkpoint(worldId);
    const service = demandList(checkpoint.input["services"]).find((item) => item["trainRunId"] === trainId && item["operatorId"] === operatorId);
    if (service === undefined || service["mode"] !== "spnv") throw new DemandError(404, "Kein berechtigtes SPNV-Manifest für diese Fahrt.");
    const stops = demandList(service["stops"]);
    const nowMs = this.currentMs;
    const activeIndex = stops.findIndex((stop, index) => index + 1 < stops.length && demandInteger(stop["departureMs"]) <= nowMs && nowMs < demandInteger(stops[index + 1]!["departureMs"]));
    if (activeIndex < 0) throw new DemandError(409, "Die Fahrt befindet sich in keinem aktiven Fahrgastabschnitt.");
    const allocation = demandList(checkpoint.result["allocations"]).find((item) => item["trainRunId"] === trainId && item["fromStopId"] === stops[activeIndex]!["stopId"]);
    const manifest = demandList(checkpoint.result["manifests"]).find((item) => item["trainRunId"] === trainId && item["segmentId"] === allocation?.["segmentId"]);
    if (manifest === undefined) throw new DemandError(503, "Abschnittsmanifest ist nicht verfügbar.");
    const stopLabel = (stopId: unknown) => this.label(stops.find((stop) => stop["stopId"] === stopId)?.["stationId"]);
    const items = demandList(manifest["passengers"]).map((passenger) => ({
      passengerId: demandText(passenger["passengerKey"]), originLabel: stopLabel(passenger["boardingStopId"]), destinationLabel: stopLabel(passenger["alightingStopId"]),
      seatClass: passenger["comfortClass"] === "premium" ? "first" : "second",
      spaceNeeds: passenger["spaceNeeds"] === "ordinary" ? [] : [demandText(passenger["spaceNeeds"])],
    }));
    return { schemaVersion: "zugfolge-passenger-manifest-view/v1", ...this.period(checkpoint), operatorId, trainId, ...this.page(items, checkpoint, cursor, limit) };
  }

  /** Reale bestehende Fahrten liefern Referenzlaufzeiten, nie fertige freie Trassen. */
  async estimateSpfv(input: SpfvEstimateInput): Promise<SpfvEstimate> {
    const checkpoint = await this.checkpoint(input.worldId);
    const source = { ...this.period(checkpoint), stateHash: checkpoint.result["stateHash"], kind: "forecast" };
    const unavailable = (message: string): SpfvEstimate => ({ source, requested: null, served: null, unserved: null,
      fareRevenueCents: null, costsCents: null, conflicts: [message], connectionEffects: [] });
    if (input.infrastructureReleaseId !== this.deps.deployment.infrastructureReleaseId) return unavailable("Nachfrage und Planung verwenden unterschiedliche Infrastrukturstände.");
    const { draft } = input;
    if (draft.validFromS * 1000 < demandInteger(checkpoint.input["windowStartMs"])
      || draft.validUntilS * 1000 > demandInteger(checkpoint.input["windowEndMs"])) return unavailable("Die Betriebszeit muss im angezeigten Nachfragefenster liegen.");
    const services = demandList(checkpoint.input["services"]);
    const pinnedPool = this.pools.find((pool) => pool["periodId"] === checkpoint.input["periodId"]);
    if (pinnedPool === undefined) return unavailable("Für diesen Zeitraum fehlt der gepinnte Referenzkorpus.");
    // Identische Referenzmenge und Reihenfolge wie bei der Projektion bestätigter
    // SPFV-Fahrten: Spielerangebote dürfen keine neue Herkunftskette eröffnen.
    const reference = [...demandList(pinnedPool["services"])].sort((left, right) => {
      const a = demandText(left["trainRunId"]), b = demandText(right["trainRunId"]);
      return a < b ? -1 : a > b ? 1 : 0;
    }).find((service) => {
      if (draft.referenceTrainId !== undefined && service["trainRunId"] !== draft.referenceTrainId) return false;
      const ids = demandList(service["stops"]).map((stop) => stop["stationId"]);
      const indices = draft.stopIds.map((id) => ids.indexOf(id));
      return indices.every((index, position) => index >= 0 && (position === 0 || index > indices[position - 1]!));
    });
    if (reference === undefined) return unavailable("Für diese Haltefolge fehlen Referenzfahrzeiten im freigegebenen Nachfragekorpus.");
    const referenceStops = demandList(reference["stops"]);
    const first = referenceStops.find((stop) => stop["stationId"] === draft.stopIds[0])!;
    const originMs = demandInteger(first["departureMs"]);
    const lineId = `spfv-proposal:${demandHash({ worldId: input.worldId, operatorId: input.operatorId, draft }).slice(0, 24)}`;
    const fare = BigInt(draft.fareCents);
    if (fare > BigInt(Number.MAX_SAFE_INTEGER)) return unavailable("Fahrpreis überschreitet den sicheren Nachfragebereich.");
    const proposed: Record<string, unknown>[] = [];
    for (let departure = draft.validFromS; departure < draft.validUntilS; departure += draft.headwayS) {
      if (proposed.length >= 256) return unavailable("Das Nachfragefenster enthält zu viele Abfahrten.");
      const trainRunId = `${lineId}:${departure}`;
      proposed.push({ ...reference, worldId: input.worldId, trainRunId, operatorId: input.operatorId, mode: "spfv", cancelled: false,
        serviceIntervalMs: draft.headwayS * 1000,
        stops: draft.stopIds.map((id, index) => {
          const stop = referenceStops.find((candidate) => candidate["stationId"] === id)!;
          return { ...stop, stopId: `${trainRunId}:${index}`, passengerStop: true,
            arrivalMs: departure * 1000 + Math.max(0, demandInteger(stop["arrivalMs"]) - originMs),
            departureMs: departure * 1000 + demandInteger(stop["departureMs"]) - originMs };
        }),
        fares: [{ id: `${lineId}:standard`, comfortClass: "standard", centsPerSegment: Number(fare), salesAvailable: true, onboardSales: true, reservationRequired: false },
          { id: `${lineId}:premium`, comfortClass: "premium", centsPerSegment: Number(fare), salesAvailable: true, onboardSales: true, reservationRequired: false }],
        capacity: { standardSeats: input.capacity - input.firstClassSeats, standardStanding: 0, premiumSeats: input.firstClassSeats,
          bicycleSpaces: input.bicyclePlaces, wheelchairSpaces: input.wheelchairPlaces, strollerSpaces: 0 },
      });
    }
    const replacements = new Set(input.replaceTrainIds ?? []);
    for (const trainId of replacements) {
      const replaced = services.find((service) => service["trainRunId"] === trainId);
      if (replaced === undefined) return unavailable("Die Nachfrage muss zunächst den bestätigten Planungsstand übernehmen.");
      if (replaced["operatorId"] !== input.operatorId || replaced["mode"] !== "spfv")
        return unavailable("Die Linienänderung referenziert ein fremdes Angebot.");
    }
    const evaluated = this.deps.runtime.evaluate({ ...checkpoint.input,
      services: [...services.filter((service) => !replacements.has(demandText(service["trainRunId"]))), ...proposed] });
    const ids = new Set(proposed.map((service) => service["trainRunId"]));
    const choices = demandList(evaluated["choices"]).filter((choice) => demandList(choice["trains"]).some((train) => ids.has(train["trainRunId"])));
    const allocations = demandList(evaluated["allocations"]).filter((allocation) => ids.has(allocation["trainRunId"]));
    const served = choices.reduce((sum, choice) => sum + demandInteger(choice["passengers"]), 0);
    const relevantOrigins = new Set(demandList(demandRecord(checkpoint.input["release"])["zones"]).filter((zone) => demandList(zone["stations"]).some((station) => draft.stopIds.includes(demandText(station["stationId"]))))
      .map((zone) => zone["id"]));
    const proposalCohorts = new Set(choices.map((choice) => choice["cohortId"]));
    const relevantCohorts = demandList(evaluated["cohorts"]).filter((cohort) => relevantOrigins.has(cohort["originZoneId"]) || proposalCohorts.has(cohort["cohortId"]));
    const cohortIds = new Set(relevantCohorts.map((cohort) => cohort["cohortId"]));
    const unserved = demandList(evaluated["unserved"]).filter((cohort) => cohortIds.has(cohort["cohortId"])).reduce((sum, cohort) => sum + demandInteger(cohort["passengers"]), 0);
    const revenue = allocations.reduce((sum, allocation) => sum + BigInt(demandInteger(allocation["forecastRevenueCents"])), 0n);
    const cost = (BigInt(input.routeDistanceMm) * BigInt(input.operatingCostCentsPerTrainKm) * BigInt(proposed.length) + 999_999n) / 1_000_000n;
    const before = demandRecord(checkpoint.result["totals"]), after = demandRecord(evaluated["totals"]);
    return { source, requested: relevantCohorts.reduce((sum, cohort) => sum + demandInteger(cohort["passengers"]), 0), served, unserved,
      fareRevenueCents: revenue.toString(), costsCents: cost.toString(), conflicts: [], connectionEffects: [
        `Schienenreisen im gesamten Fenster: ${demandInteger(before["rail"])} → ${demandInteger(after["rail"])}.`,
        `Unbediente Reisen im gesamten Fenster: ${demandInteger(before["unserved"])} → ${demandInteger(after["unserved"])}.`,
        `${choices.filter((choice) => demandList(choice["trains"]).length > 1).reduce((sum, choice) => sum + demandInteger(choice["passengers"]), 0)} Reisende nutzen die neue Linie mit Umstieg.`,
        "Fahrzeiten, Komfort und Zuverlässigkeit basieren auf der Referenzfahrt; die echte Trassenprüfung kann das Angebot verändern.",
      ] };
  }
}
