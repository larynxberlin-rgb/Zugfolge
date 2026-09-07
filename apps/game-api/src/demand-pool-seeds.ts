import { domainEvents, regionalSimulationStates, worlds } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { DemandRuntime } from "@zugfolge/runtime-native";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DemandRegionBinding } from "./demand-progress.js";
import { DEMAND_MAX_BYTES, DemandError, appendDemandEvent, demandHash, demandInteger, demandList, demandRecord, demandText } from "./demand-store.js";

export const DEMAND_POOL_INITIALIZED_EVENT = "demand.pool-initialized";
const MAX_POOLS = 256;

interface InitialRegionWatermark extends Readonly<Record<string, unknown>> {
  readonly regionId: string;
  readonly initializationHash: string;
  readonly commitSequence: number;
  readonly nativeEventSequence: number;
  readonly completeThroughMs: number;
}

export interface DemandPoolSeed {
  readonly schemaVersion: "zugfolge-demand-pool-seed/v1";
  readonly worldId: string;
  readonly periodId: string;
  readonly deploymentHash: string;
  readonly templateHash: string;
  readonly template: Readonly<Record<string, unknown>>;
  readonly inputHash: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly resultHash: string;
  readonly result: Readonly<Record<string, unknown>>;
  readonly initialWatermark: {
    readonly nowMs: number;
    readonly maxNowMs: number;
    readonly regions: readonly InitialRegionWatermark[];
  };
  /** Tatsächlich unter Weltmutex gelesener Journalkopf vor dem Seed. */
  readonly throughWorldSequence: number;
  /** Vor der ersten vorhandenen Ankunft: der Consumer liest diese erneut. */
  readonly startWorldSequence: number;
  readonly seedHash: string;
}

function assertBounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > DEMAND_MAX_BYTES)
    throw new DemandError(503, "Nachfrage-Anfangscheckpoint überschreitet die freigegebene Größe.");
}

/** Kein Runtime-Import des Consumers: dieser liest selbst die Seeds. */
async function initialWatermark(db: IdentityDatabase, worldId: string, bindings: readonly DemandRegionBinding[]): Promise<DemandPoolSeed["initialWatermark"]> {
  if (bindings.length === 0 || bindings.length > 256 || bindings.some((binding) => binding.worldId !== worldId)
    || new Set(bindings.map((binding) => binding.regionId)).size !== bindings.length)
    throw new DemandError(503, "Vollständige regionale Nachfragebindung fehlt.");
  const rows = await db.select({ regionId: regionalSimulationStates.regionId, initializationHash: regionalSimulationStates.initializationHash,
    revision: regionalSimulationStates.revision, worldId: sql<unknown>`${regionalSimulationStates.state}->'world'->>'worldId'`,
    nowMs: sql<unknown>`${regionalSimulationStates.state}->'world'->>'nowMs'`,
    nativeEventSequence: sql<unknown>`${regionalSimulationStates.state}->'world'->>'eventSequence'`,
  }).from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, worldId),
    inArray(regionalSimulationStates.regionId, bindings.map((binding) => binding.regionId))));
  if (rows.length !== bindings.length) throw new DemandError(503, "Eine Nachfrage-Region hat noch keinen bestätigten Betriebsstand.");
  const regions = rows.map((row) => {
    if (row.worldId !== worldId || row.initializationHash !== bindings.find((binding) => binding.regionId === row.regionId)?.initializationHash
      || !/^\d+$/u.test(String(row.nowMs)) || !/^\d+$/u.test(String(row.nativeEventSequence)))
      throw new DemandError(503, "Regionaler Nachfragebeleg verletzt den signierten Initialisierungspin.");
    return { regionId: row.regionId, initializationHash: row.initializationHash, commitSequence: demandInteger(row.revision),
      nativeEventSequence: demandInteger(Number(row.nativeEventSequence)), completeThroughMs: demandInteger(Number(row.nowMs)) };
  }).sort((a, b) => a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0);
  return { nowMs: Math.min(...regions.map((region) => region.completeThroughMs)),
    maxNowMs: Math.max(...regions.map((region) => region.completeThroughMs)), regions };
}

function validateSeed(value: unknown, runtime: DemandRuntime, worldId: string, periodId: string, deploymentHash: string): DemandPoolSeed {
  assertBounded(value);
  const raw = demandRecord(value);
  const { seedHash, ...body } = raw;
  if (seedHash !== demandHash(body)) throw new DemandError(503, "Nachfrage-Anfangscheckpoint besitzt einen beschädigten Hash.");
  const seed = raw as unknown as DemandPoolSeed;
  if (seed.schemaVersion !== "zugfolge-demand-pool-seed/v1" || seed.worldId !== worldId || seed.periodId !== periodId
    || seed.template["worldId"] !== worldId || seed.template["periodId"] !== periodId
    || seed.input["worldId"] !== worldId || seed.input["periodId"] !== periodId
    || seed.result["worldId"] !== worldId || seed.result["periodId"] !== periodId
    || seed.templateHash !== demandHash(seed.template) || seed.inputHash !== demandHash(seed.input)
    || seed.resultHash !== demandHash(seed.result)) throw new DemandError(503, "Nachfrage-Anfangscheckpoint verletzt Herkunft oder Weltbindung.");
  if (seed.deploymentHash !== deploymentHash) throw new DemandError(409, "Nachfrage-Anfangscheckpoint besitzt einen anderen Releasepin.");
  demandInteger(seed.throughWorldSequence); demandInteger(seed.startWorldSequence);
  if (seed.startWorldSequence > seed.throughWorldSequence) throw new DemandError(503, "Nachfrage-Anfangscursor liegt nach seinem Journalkopf.");
  const watermark = demandRecord(seed.initialWatermark);
  const regions = demandList(watermark["regions"]);
  if (regions.length === 0 || regions.length > 256 || new Set(regions.map((region) => demandText(region["regionId"]))).size !== regions.length)
    throw new DemandError(503, "Nachfrage-Anfangscheckpoint besitzt keine eindeutige Regionsbindung.");
  for (const region of regions) {
    demandText(region["initializationHash"]); demandInteger(region["commitSequence"]);
    demandInteger(region["nativeEventSequence"]); demandInteger(region["completeThroughMs"]);
  }
  if (watermark["nowMs"] !== Math.min(...regions.map((region) => demandInteger(region["completeThroughMs"])))
    || watermark["maxNowMs"] !== Math.max(...regions.map((region) => demandInteger(region["completeThroughMs"])))
    || seed.inputHash !== demandHash({ ...seed.template, nowMs: watermark["nowMs"], revision: 1 }))
    throw new DemandError(503, "Nachfrage-Anfangscheckpoint besitzt eine widersprüchliche Anfangszeit.");
  if (demandHash(runtime.evaluate(seed.input)) !== seed.resultHash)
    throw new DemandError(503, "Nachfrage-Anfangscheckpoint besteht den Rust-Replay nicht.");
  return seed;
}

/** Private unveränderliche Basis; ersetzt niemals die öffentliche Nachfrageauswertung. */
export async function loadDemandPoolSeed(db: IdentityDatabase, runtime: DemandRuntime, worldId: string, periodId: string,
  deploymentHash: string): Promise<DemandPoolSeed | undefined> {
  const events = await db.select({ payload: domainEvents.payload }).from(domainEvents).where(and(eq(domainEvents.worldId, worldId),
    eq(domainEvents.eventType, DEMAND_POOL_INITIALIZED_EVENT), sql`${domainEvents.payload}->>'periodId' = ${periodId}`))
    .orderBy(asc(domainEvents.sequence)).limit(2);
  if (events.length > 1) throw new DemandError(503, "Nachfragepool besitzt mehrere Anfangscheckpoints.");
  return events[0] === undefined ? undefined : validateSeed(events[0].payload, runtime, worldId, periodId, deploymentHash);
}

/** Alle freigegebenen Pools werden vor dem ersten Regional-Advance atomar gepinnt. */
export async function pinDemandPoolSeeds(db: IdentityDatabase, runtime: DemandRuntime, worldId: string,
  templates: readonly Readonly<Record<string, unknown>>[], deploymentHash: string, occurredAt: Date,
  regionBindings: readonly DemandRegionBinding[]): Promise<readonly DemandPoolSeed[]> {
  if (templates.length === 0 || templates.length > MAX_POOLS
    || new Set(templates.map((template) => demandText(template["periodId"]))).size !== templates.length
    || templates.some((template) => template["worldId"] !== worldId || template["previousEvaluation"] !== undefined
      || template["operationalProgress"] !== undefined) || !/^[a-f0-9]{64}$/u.test(deploymentHash))
    throw new DemandError(503, "Nachfrage-Anfangspools besitzen keine eindeutige Freigabe.");
  return db.transaction(async (tx) => {
    const [world] = await tx.select({ lifecycleStatus: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, worldId)).for("update");
    if (world === undefined || world.lifecycleStatus !== "active") throw new DemandError(409, "Spielwelt ist nicht aktiv.");
    const watermark = await initialWatermark(tx, worldId, regionBindings);
    const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents)
      .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
    const throughWorldSequence = head?.sequence ?? 0;
    const seeds: DemandPoolSeed[] = [];
    for (const template of templates) {
      assertBounded(template);
      const periodId = demandText(template["periodId"]);
      const existing = await loadDemandPoolSeed(tx, runtime, worldId, periodId, deploymentHash);
      if (existing !== undefined) {
        if (existing.templateHash !== demandHash(template)) throw new DemandError(409, "Nachfragepool wurde nach seinem Anfangscheckpoint verändert.");
        if (existing.initialWatermark.regions.length !== watermark.regions.length || existing.initialWatermark.regions.some((old) => {
          const current = watermark.regions.find((region) => region.regionId === old.regionId);
          return current === undefined || current.initializationHash !== old.initializationHash
            || current.commitSequence < old.commitSequence || current.nativeEventSequence < old.nativeEventSequence
            || current.completeThroughMs < old.completeThroughMs;
        })) throw new DemandError(409, "Nachfrage-Anfangsbindung oder Regionsstand ist zurückgegangen.");
        seeds.push(existing); continue;
      }
      const services = demandList(template["services"]);
      const firstDeparture = Math.min(...services.map((service) => demandInteger(demandList(service["stops"])[0]?.["departureMs"])));
      if (watermark.maxNowMs > firstDeparture) throw new DemandError(503, "Autoritative Nachfrage benötigt ihren Anfangscheckpoint vor der ersten Abfahrt aller Regionen.");
      const trainIds = services.map((service) => demandText(service["trainRunId"]));
      const relevant = trainIds.length === 0 ? sql`false` : inArray(sql<string>`${domainEvents.payload}->>'trainRunId'`, trainIds);
      const [departure] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(and(eq(domainEvents.worldId, worldId),
        eq(domainEvents.eventType, "operations.passenger-stop-departure"), relevant)).limit(1);
      if (departure !== undefined) throw new DemandError(503, "Ein Abfahrtsbeleg liegt bereits vor dem Nachfrage-Anfangscheckpoint.");
      const [arrival] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(and(eq(domainEvents.worldId, worldId),
        eq(domainEvents.eventType, "operations.passenger-stop-arrival"), relevant)).orderBy(asc(domainEvents.sequence)).limit(1);
      const input = { ...template, nowMs: watermark.nowMs, revision: 1 };
      const result = runtime.evaluate(input);
      const body = { schemaVersion: "zugfolge-demand-pool-seed/v1" as const, worldId, periodId, deploymentHash,
        templateHash: demandHash(template), template, inputHash: demandHash(input), input, resultHash: demandHash(result), result,
        initialWatermark: watermark, throughWorldSequence, startWorldSequence: arrival === undefined ? throughWorldSequence : arrival.sequence - 1 };
      const seed: DemandPoolSeed = { ...body, seedHash: demandHash(body) };
      assertBounded(seed);
      await appendDemandEvent(tx, worldId, DEMAND_POOL_INITIALIZED_EVENT, seed, occurredAt);
      seeds.push(seed);
    }
    return seeds;
  });
}
