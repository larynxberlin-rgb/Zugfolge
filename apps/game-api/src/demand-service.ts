import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { DemandRuntime } from "@zugfolge/runtime-native";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { LivemapReadModel, LivemapRegistry } from "@zugfolge/livemap-stream";
import type { PlanningInfrastructureRelease } from "@zugfolge/planning-worker";
import { worlds } from "@zugfolge/db";
import { eq } from "drizzle-orm";
import { DEMAND_PROGRESS_EVENT, DemandError, DemandStore, demandHash, demandInteger, demandList, demandRecord, demandText, type DemandCheckpoint } from "./demand-store.js";
import type { SpfvEstimate, SpfvEstimateInput } from "./spfv-service.js";
import { loadCommittedSpfvServices } from "./spfv-demand-projection.js";
import { DemandProgressConsumer, demandProgressFromReceipts, demandRegionalWatermark, hasUnfinishedActualJourney, type DemandRegionBinding } from "./demand-progress.js";
import { pinDemandPoolSeeds } from "./demand-pool-seeds.js";
import { loadPopulationDataHistory, populationRevisionOf, savePopulationData, type PopulationDataCommand } from "./demand-population-data.js";

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
  /** Vollständige signierte Regionsmenge; ohne sie bleibt die Projektion ein Forecast. */
  readonly operationalRegions?: () => readonly DemandRegionBinding[];
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
  private seedsPrepared = false;
  private failure = "Nachfrage wartet auf den ersten bestätigten Betriebsstand.";
  private currentMs = 0;
  private readonly verifiedWindows = new Set<Readonly<Record<string, unknown>>>();
  private readonly pools: DemandDeployment["windows"];
  private readonly stations: Map<string, { id: string; name: string; longitudeE7: number; latitudeE7: number }>;
  private readonly progress: DemandProgressConsumer | undefined;

  constructor(private readonly deps: DemandServiceDependencies) {
    this.store = new DemandStore(deps.db, deps.runtime);
    this.progress = deps.operationalRegions === undefined ? undefined : new DemandProgressConsumer(deps.db, deps.runtime, deps.operationalRegions);
    this.pools = poolDemandWindows(deps.deployment.windows);
    const trainPools = new Map<string, unknown>();
    for (const pool of this.pools) for (const service of demandList(pool["services"])) {
      const trainId = demandText(service["trainRunId"]);
      if (trainPools.has(trainId)) throw new DemandError(503, "Fahrtkennung wird in verschiedenen Nachfrageperioden wiederverwendet.");
      trainPools.set(trainId, pool["periodId"]);
    }
    for (let index = 1; index < this.pools.length; index += 1) {
      if (demandInteger(this.pools[index]!["windowStartMs"]) < demandHorizon(this.pools[index - 1]!))
        throw new DemandError(503, "Fahrten verschiedener Nachfragereleases überlappen am Periodenwechsel; ein gemeinsamer Übergangsbeleg fehlt.");
    }
    this.stations = new Map(deps.infrastructure.filter((release) => release.worldId === deps.deployment.worldId && release.releaseId === deps.deployment.infrastructureReleaseId)
      .flatMap((release) => release.stations).map((station) => [station.id, station]));
  }

  private assertWorld(worldId: string): void {
    if (worldId !== this.deps.deployment.worldId) throw new DemandError(404, "Für diese Welt liegen keine Nachfragedaten vor.");
  }

  /** Automatischer Odoo-Speichereffekt, innerhalb derselben Transaktion wie die
   * signierte Queue-Quittierung. Kein manueller Freigabe- oder Exportpfad. */
  async updateData(command: PopulationDataCommand, db: IdentityDatabase, occurredAt: Date) {
    if (command.worldId !== this.deps.deployment.worldId) return { outcome: "rejected" as const, code: "world_scope" };
    await db.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, command.worldId)).for("update");
    const previous = await new DemandStore(db, this.deps.runtime).latest(command.worldId);
    const effectiveAtMs = this.deps.operationalRegions === undefined
      ? Math.max(this.currentMs, previous === undefined ? 0 : demandInteger(previous.input["nowMs"]))
      : (await demandRegionalWatermark(db, command.worldId, this.deps.operationalRegions())).nowMs;
    return savePopulationData(db, this.deps.runtime, command, this.pools, effectiveAtMs, occurredAt);
  }

  /** Vor dem ersten Advance muss das gepinnte Anfangsmanifest existieren. */
  async prepareOperationalCycle(occurredAt: Date): Promise<void> {
    if (this.deps.operationalRegions === undefined) return;
    const regions = this.deps.operationalRegions();
    if (!this.seedsPrepared) {
      const config = await this.deps.readModel?.getConfig(this.deps.deployment.worldId);
      if (config?.infrastructureReleaseId !== this.deps.deployment.infrastructureReleaseId)
        throw new DemandError(503, "Nachfrage und aktive Spielkarte verwenden unterschiedliche Infrastruktur.");
      for (const template of this.pools) await this.verifyTemplate(template);
      await pinDemandPoolSeeds(this.deps.db, this.deps.runtime, this.deps.deployment.worldId,
        this.pools, this.deps.deploymentHash, occurredAt, regions);
      this.seedsPrepared = true;
    }
    const watermark = await demandRegionalWatermark(this.deps.db, this.deps.deployment.worldId, regions);
    // Catch-up kann mehrere bereits vor Betriebsbeginn gepinnte Pools umfassen.
    // Jeden geöffneten Pool erst vollständig konsumieren, dann weiterwechseln.
    for (let attempt = 0; attempt <= this.pools.length; attempt += 1) {
      const before = await this.store.latest(this.deps.deployment.worldId);
      await this.refresh(watermark.nowMs, occurredAt);
      const after = await this.store.latest(this.deps.deployment.worldId);
      if (after === undefined || after.inputHash === before?.inputHash || hasUnfinishedActualJourney(after)) break;
      const index = this.pools.findIndex((pool) => pool["periodId"] === after.input["periodId"]);
      const next = this.pools[index + 1];
      if (next === undefined || demandInteger(next["windowStartMs"]) > watermark.nowMs
        || demandHorizon(after.input) > watermark.nowMs) break;
    }
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
        // Operational v2 bestätigt Bewegung und Haltbelege. Sein öffentlicher
        // Snapshot publiziert keine Ausfälle oder additiven Verspätungswerte.
        // Ein unhistorisierter Legacywert darf keine vergangene Zugwahl ändern.
        if (this.progress !== undefined) {
          if (train !== undefined && (train.operatorId !== service["operatorId"] || train.status === "cancelled"
            || (train.delaySeconds !== undefined && train.delaySeconds !== 0)))
            throw new DemandError(503, "Nachfrage-Angebotsänderung besitzt keinen zeitgebundenen autoritativen Beleg.");
          return service;
        }
        if (train === undefined) return previousServices.get(service["trainRunId"]) ?? service;
        if (train.operatorId !== service["operatorId"]) throw new DemandError(503, "Nachfragezug gehört nicht zum bestätigten Betreiber.");
        const delayMs = (train.delaySeconds ?? 0) * 1000;
        return { ...service, cancelled: train.status === "cancelled", stops: demandList(service["stops"]).map((stop) => ({
          ...stop, arrivalMs: demandInteger(stop["arrivalMs"]) + delayMs, departureMs: demandInteger(stop["departureMs"]) + delayMs,
        })) };
      });
      const opened = previous?.input["periodId"] === template["periodId"];
      const unopened = this.progress !== undefined && !opened;
      const tailPending = this.progress !== undefined && opened && previous?.progressCursor !== undefined
        && demandInteger(previous.progressCursor["safeThroughMs"]) < Math.max(0, nowMs - 1);
      if (unopened || tailPending || nowMs < demandHorizon(template, services)
        || (opened && hasUnfinishedActualJourney(previous))) {
        selected = { template, services, provenance: accepted.provenance }; break;
      }
    }
    if (selected === undefined) {
      if (this.progress !== undefined) {
        this.available = previous !== undefined;
        this.failure = previous === undefined ? "Das freigegebene Nachfragefenster hat noch nicht begonnen." : "";
        return;
      }
      throw new DemandError(503, "Für diesen Zeitraum ist kein Nachfragerelease freigegeben.");
    }
    const { template, services, provenance } = selected;
    await this.verifyTemplate(template);
    if (this.progress !== undefined) {
      const checkpoint = await this.progress.advance(template, services, this.deps.deploymentHash, occurredAt, provenance);
      this.currentMs = demandInteger(checkpoint.input["nowMs"]);
      this.available = true; this.failure = "";
      return;
    }
    this.lastInputHash = await this.deps.db.transaction(async (tx) => {
      await tx.select({ id: worlds.id }).from(worlds).where(eq(worlds.id, deployment.worldId)).for("update");
      const store = new DemandStore(tx, this.deps.runtime);
      const previous = await store.latest(deployment.worldId);
      if (previous !== undefined && demandInteger(previous.input["nowMs"]) > nowMs) throw new DemandError(409, "Nachfragezeit darf nicht zurückgehen.");
      const sameDataPool = previous?.input["periodId"] === template["periodId"];
      let populationRevision = sameDataPool ? populationRevisionOf(previous!.input) : undefined;
      const dataHistory = demandRecord(template["release"])["populationModel"] === undefined ? []
        : (await loadPopulationDataHistory(tx, deployment.worldId, demandText(demandRecord(template["release"])["id"]),
          populationRevision?.revision ?? 0, Number.MAX_SAFE_INTEGER, sameDataPool ? undefined : nowMs)).filter((event) => event.snapshot.effectiveAtMs <= nowMs);
      const nextPopulation = dataHistory.at(-1)?.snapshot ?? populationRevision;
      const signature = demandHash({ ...template, services, nowMs: 0, revision: 0,
        ...(nextPopulation === undefined ? {} : { populationRevision: nextPopulation }) });
      if (signature === this.lastInputHash) return signature;
      if (previous !== undefined && previous.deploymentHash === this.deps.deploymentHash
        && sameDataPool && signature === demandHash({ ...template, services: previous.input["services"], nowMs: 0, revision: 0,
          ...(populationRevisionOf(previous.input) === undefined ? {} : { populationRevision: populationRevisionOf(previous.input) }) })) {
        return signature;
      }
      let current = sameDataPool ? previous : undefined;
      let revision = previous === undefined ? 0 : demandInteger(previous.input["revision"]);
      if (current !== undefined) for (const event of dataHistory) {
        populationRevision = event.snapshot;
        const atMs = event.snapshot.effectiveAtMs;
        current = await store.commit({ ...template, services: current.input["services"], nowMs: atMs, revision: ++revision,
          populationRevision, previousEvaluation: { services: current.input["services"], result: current.result },
          operationalProgress: demandProgressFromReceipts(deployment.worldId, atMs, []) }, this.deps.deploymentHash, occurredAt,
        provenance, undefined, true, DEMAND_PROGRESS_EVENT);
      }
      const input = { ...template, services, nowMs, revision: ++revision,
        ...(nextPopulation === undefined ? {} : { populationRevision: nextPopulation }),
        ...(current === undefined || nextPopulation === undefined ? {} : {
          previousEvaluation: { services: current.input["services"], result: current.result },
          operationalProgress: demandProgressFromReceipts(deployment.worldId, nowMs, []),
        }) };
      await store.commit(input, this.deps.deploymentHash, occurredAt, provenance, undefined, true);
      return signature;
    });
    this.available = true;
    this.failure = "";
  }

  private async verifyTemplate(template: Readonly<Record<string, unknown>>): Promise<void> {
    const { readModel, deployment } = this.deps;
    if (!this.verifiedWindows.has(template)) {
      if (readModel?.getScheduledCall === undefined) throw new DemandError(503, "Exakte Fahrplanreferenzen für Nachfrage fehlen.");
      const model = demandRecord(template["release"])["populationModel"];
      if (model !== undefined) {
        const stations = new Set(this.deps.infrastructure.filter((release) => release.worldId === deployment.worldId
          && release.releaseId === deployment.infrastructureReleaseId).flatMap((release) => release.stations.map((station) => station.id)));
        if (demandList(demandRecord(model)["stationAreas"]).some((area) => !stations.has(demandText(area["stationId"]))))
          throw new DemandError(503, "Einwohnernachfrage verweist auf Stationen außerhalb der gepinnten Spielkarte.");
      }
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
  }

  async checkpoint(worldId: string, db?: IdentityDatabase): Promise<DemandCheckpoint> {
    this.assertWorld(worldId);
    if (!this.available) throw new DemandError(503, this.failure);
    // SPFV reads under its world mutex on the same connection. Opening a read
    // through the outer pool can deadlock a single-connection database. A scoped
    // verifier also avoids caching facts from a transaction that may roll back.
    const store = db === undefined ? this.store : new DemandStore(db, this.deps.runtime);
    const checkpoint = await store.latest(worldId, this.deps.deploymentHash);
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
    const release = demandRecord(checkpoint.input["release"]);
    const cohorts = demandList(checkpoint.result["cohorts"]);
    const dataRevision = populationRevisionOf(checkpoint.input);
    const populationModel = dataRevision?.populationModel ?? (release["populationModel"] === undefined ? undefined : demandRecord(release["populationModel"]));
    const areas = populationModel === undefined ? [] : demandList(populationModel["stationAreas"]);
    const preferences = populationModel === undefined ? [] : demandList(populationModel["destinationPreferences"]);
    const counts = new Map<string, number>();
    // Auch ein unbedienter Zugang behält seine Einwohnerbasis und Wunschziele.
    for (const area of areas) counts.set(demandText(area["stationId"]), 0);
    for (const flow of flows) {
      const service = services.find((candidate) => candidate["trainRunId"] === flow["trainRunId"]);
      const stop = service === undefined ? undefined : demandList(service["stops"]).find((candidate) => candidate["stopId"] === flow["stopId"]);
      if (stop !== undefined) counts.set(demandText(stop["stationId"]), (counts.get(demandText(stop["stationId"])) ?? 0) + demandInteger(flow["boarding"]));
    }
    const items = [...counts.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([stationId, servedPassengers]) => {
      const station = this.stations.get(stationId);
      const area = areas.find((candidate) => candidate["stationId"] === stationId);
      const wishes = new Map<string, number>();
      if (area !== undefined) for (const cohort of cohorts) {
        if (cohort["originZoneId"] !== area["zoneId"]) continue;
        const destination = demandText(cohort["destinationZoneId"]);
        wishes.set(destination, (wishes.get(destination) ?? 0) + demandInteger(cohort["passengers"]));
      }
      const populationDemand = area === undefined ? undefined : {
        demandClass: demandInteger(area["demandClass"]),
        catchmentPopulation: demandList(area["populationAllocations"]).reduce((sum, allocation) => sum + demandInteger(allocation["population"]), 0),
        requestedPassengers: [...wishes.values()].reduce((sum, passengers) => sum + passengers, 0),
        topDestinations: [...wishes.entries()].sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : a > b ? 1 : 0)).slice(0, 5).map(([zoneId, passengers]) => {
          const destination = areas.find((candidate) => candidate["zoneId"] === zoneId)!;
          const destinationStationId = demandText(destination["stationId"]);
          const preference = preferences.find((candidate) => candidate["originZoneId"] === area["zoneId"] && candidate["destinationZoneId"] === zoneId);
          return { stationId: destinationStationId, label: this.label(destinationStationId), passengers,
            referenceConnections: preference === undefined ? 0 : demandInteger(preference["referenceConnections"]) };
        }),
      };
      return { stationId, label: station?.name ?? stationId,
        ...(station === undefined ? {} : { longitudeE7: station.longitudeE7, latitudeE7: station.latitudeE7 }),
        ...(populationDemand === undefined ? {} : { populationDemand }),
        requestedPassengers: null, servedPassengers, unservedPassengers: null };
    });
    const choices = demandList(checkpoint.result["choices"]);
    const unserved = demandList(checkpoint.result["unserved"]);
    const zones = demandList(release["zones"]).map((zone) => {
      const origin = cohorts.filter((cohort) => cohort["originZoneId"] === zone["id"]);
      const ids = new Set(origin.map((cohort) => cohort["cohortId"]));
      const area = areas.find((candidate) => candidate["zoneId"] === zone["id"]);
      return { zoneId: demandText(zone["id"]), label: area === undefined ? `Gebiet ${demandText(zone["id"])}` : `Einzugsgebiet ${this.label(area["stationId"])}`,
        requestedPassengers: origin.reduce((sum, cohort) => sum + demandInteger(cohort["passengers"]), 0),
        servedPassengers: choices.filter((choice) => ids.has(choice["cohortId"]) && choice["alternativeMode"] === null).reduce((sum, choice) => sum + demandInteger(choice["passengers"]), 0),
        alternativePassengers: choices.filter((choice) => ids.has(choice["cohortId"]) && choice["alternativeMode"] !== null).reduce((sum, choice) => sum + demandInteger(choice["passengers"]), 0),
        unservedPassengers: unserved.filter((choice) => ids.has(choice["cohortId"])).reduce((sum, choice) => sum + demandInteger(choice["passengers"]), 0),
      };
    }).sort((a, b) => a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0);
    const length = Math.max(items.length, zones.length);
    const indices = this.page(Array.from({ length }, (_, index) => index), checkpoint, cursor, limit);
    const referenceDates = populationModel === undefined ? [] : [...demandRecord(populationModel["referenceTimetable"])["serviceDates"] as string[]].sort();
    return { schemaVersion: "zugfolge-demand-overview/v1", ...this.period(checkpoint),
      ...(populationModel === undefined ? {} : { populationBasis: {
        referenceStartDate: referenceDates[0]!, referenceEndDate: referenceDates.at(-1)!,
        ...(dataRevision === undefined ? {} : { dataRevision: dataRevision.revision, correctedAtS: Math.trunc(dataRevision.effectiveAtMs / 1000) }),
        sources: demandList(release["sources"]).map((source) => ({ label: demandText(source["id"]), url: demandText(source["url"]), license: demandText(source["license"]),
          ...(source["id"] === "bkg-vg250-ew-2024" ? {
            attribution: "© BKG 2026; Datenquellen BKG / Statistisches Bundesamt; Auswahl und Modellableitung: Zugfolge",
            licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
            attributionUrl: "https://sgx.geodatenzentrum.de/web_public/gdz/datenquellen/datenquellen_vg_nuts.pdf",
          } : source["id"] === "gtfs-de-rv" || source["id"] === "gtfs-de-fv" ? {
            attribution: "GTFS.DE / DELFI e.V.; Auswahl und Modellableitung: Zugfolge",
            licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
          } : {}),
        })),
      } }),
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
    const progress = checkpoint.result["operationalProgress"];
    const trainProgress = progress == null ? undefined : demandList(demandRecord(progress)["trains"]).find((train) => train["trainRunId"] === trainId);
    const actualStops = trainProgress === undefined ? [] : demandList(trainProgress["stops"]);
    const actual = (stopId: unknown, field: string) => actualStops.find((stop) => stop["stopId"] === stopId)?.[field];
    const actualMode = checkpoint.progressCursor !== undefined;
    const activeIndex = stops.findIndex((stop, index) => index + 1 < stops.length && (actualMode
      ? actual(stop["stopId"], "actualDepartureMs") != null && actual(stops[index + 1]!["stopId"], "actualArrivalMs") == null
      : demandInteger(stop["departureMs"]) <= nowMs && nowMs < demandInteger(stops[index + 1]!["departureMs"])));
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
    return { schemaVersion: "zugfolge-passenger-manifest-view/v1", ...this.period(checkpoint),
      ...(actualMode ? { source: "confirmed" as const } : {}), operatorId, trainId, ...this.page(items, checkpoint, cursor, limit) };
  }

  /** Reale bestehende Fahrten liefern Referenzlaufzeiten, nie fertige freie Trassen. */
  async estimateSpfv(input: SpfvEstimateInput, db?: IdentityDatabase): Promise<SpfvEstimate> {
    const checkpoint = await this.checkpoint(input.worldId, db);
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
