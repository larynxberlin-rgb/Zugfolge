import { domainEvents, worlds } from "@zugfolge/db";
import type { IdentityDatabase } from "@zugfolge/identity";
import type { DemandRuntime } from "@zugfolge/runtime-native";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { appendDemandEvent, DemandError, DemandStore, demandHash, demandInteger, demandRecord } from "./demand-store.js";

export const DEMAND_POPULATION_EVENT = "demand.population-data-updated";
export interface PopulationDataCommand {
  readonly kind: "demand.data.update";
  readonly schemaVersion: "zugfolge-demand-data-update/v1";
  readonly worldId: string;
  readonly sourceRevision: number;
  readonly baseReleaseId: string;
  readonly populationModel: Readonly<Record<string, unknown>>;
  readonly zonePopulations: readonly { readonly zoneId: string; readonly population: number }[];
}
export interface PopulationRevision {
  readonly schemaVersion: "zugfolge-demand-population-revision/v1";
  readonly worldId: string;
  readonly revision: number;
  readonly effectiveAtMs: number;
  readonly populationModel: Readonly<Record<string, unknown>>;
  readonly zonePopulations: readonly { readonly zoneId: string; readonly population: number }[];
}
export interface PopulationDataEvent {
  readonly worldSequence: number;
  readonly snapshot: PopulationRevision;
}

function eventValue(payload: unknown, worldId: string, baseReleaseId: string): PopulationRevision {
  const event = demandRecord(payload), value = demandRecord(event["snapshot"]) as unknown as PopulationRevision;
  if (event["schemaVersion"] !== "zugfolge-demand-population-data-event/v1" || event["worldId"] !== worldId
    || event["baseReleaseId"] !== baseReleaseId || value.schemaVersion !== "zugfolge-demand-population-revision/v1"
    || value.worldId !== worldId || demandHash(value) !== event["snapshotHash"]) throw new DemandError(503, "Gespeicherte Einwohnerkorrektur verletzt ihre Datenbindung.");
  if (demandInteger(value.revision) < 1) throw new DemandError(503, "Datenrevision fehlt.");
  demandInteger(value.effectiveAtMs);
  return value;
}

/** Normale Odoo-Tabellen sind die Pflegequelle. Das Game hält lokale, automatisch
 * empfangene Datenstände und ihren Replaybeleg, ohne Odoo im Simulationspfad. */
export async function savePopulationData(db: IdentityDatabase, runtime: DemandRuntime, command: PopulationDataCommand,
  templates: readonly Readonly<Record<string, unknown>>[], effectiveAtMs: number, occurredAt: Date) {
  const worldId = command.worldId;
  const [world] = await db.select({ id: worlds.id, lifecycleStatus: worlds.lifecycleStatus }).from(worlds).where(eq(worlds.id, worldId)).for("update");
  if (world === undefined || world.lifecycleStatus !== "active") return { outcome: "rejected" as const, code: "world_inactive" };
  const selected = templates.filter((template) => template["worldId"] === worldId && demandRecord(template["release"])["id"] === command.baseReleaseId);
  if (selected.length === 0) return { outcome: "rejected" as const, code: "unknown_demand_basis" };
  const [previous] = await db.select().from(domainEvents).where(and(eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, DEMAND_POPULATION_EVENT),
    eq(sql<string>`${domainEvents.payload}->>'baseReleaseId'`, command.baseReleaseId))).orderBy(desc(domainEvents.sequence)).limit(1);
  const commandHash = demandHash(command);
  if (previous !== undefined) {
    const old = eventValue(previous.payload, worldId, command.baseReleaseId);
    if (old.revision > command.sourceRevision) return { outcome: "accepted" as const, code: "superseded" };
    if (old.revision === command.sourceRevision) return demandRecord(previous.payload)["commandHash"] === commandHash
      ? { outcome: "accepted" as const, code: "duplicate" } : { outcome: "rejected" as const, code: "revision_conflict" };
    if (old.effectiveAtMs > effectiveAtMs) return { outcome: "rejected" as const, code: "simulation_time_regressed" };
  }
  const snapshot: PopulationRevision = { schemaVersion: "zugfolge-demand-population-revision/v1", worldId,
    revision: command.sourceRevision, effectiveAtMs, populationModel: command.populationModel, zonePopulations: command.zonePopulations };
  try {
    demandInteger(effectiveAtMs);
    // Der echte Kern validiert Quellen-, Stations-, Summen- und Feldbindungen.
    // Jede vorhandene Periodenkonfiguration muss den neuen Zahlenstand tragen.
    for (const template of selected) runtime.evaluate({ ...template, nowMs: Math.max(effectiveAtMs, demandInteger(template["nowMs"])),
      populationRevision: snapshot, revision: 1 });
    const checkpoint = await new DemandStore(db, runtime).latest(worldId);
    if (checkpoint !== undefined && demandRecord(checkpoint.input["release"])["id"] === command.baseReleaseId) {
      let currentInput = checkpoint.input, currentResult = checkpoint.result;
      const pending = await loadPopulationDataHistory(db, worldId, command.baseReleaseId,
        populationRevisionOf(currentInput)?.revision ?? 0, Number.MAX_SAFE_INTEGER);
      for (const populationRevision of [...pending.map((event) => event.snapshot), snapshot]) {
        const progress = currentResult["operationalProgress"] == null
          ? { schemaVersion: "demand-operational-progress/v1", worldId, trains: [] }
          : demandRecord(currentResult["operationalProgress"]);
        const operationalProgress = { ...progress, asOfMs: populationRevision.effectiveAtMs,
          receiptId: demandHash({ progress, atMs: populationRevision.effectiveAtMs }) };
        const nextInput = { ...currentInput, nowMs: populationRevision.effectiveAtMs,
          revision: demandInteger(currentInput["revision"]) + 1, populationRevision, operationalProgress,
          previousEvaluation: { services: currentInput["services"], result: currentResult } };
        currentResult = runtime.evaluate(nextInput); currentInput = nextInput;
      }
    }
  } catch { return { outcome: "rejected" as const, code: "invalid_population_data", detail: "Einwohner, Stationsanteile oder Verbindungswerte verletzen die Nachfragegrundlage." }; }
  await appendDemandEvent(db, worldId, DEMAND_POPULATION_EVENT, { schemaVersion: "zugfolge-demand-population-data-event/v1",
    worldId, baseReleaseId: command.baseReleaseId, sourceRevision: command.sourceRevision, commandHash,
    snapshot, snapshotHash: demandHash(snapshot) }, occurredAt);
  return { outcome: "accepted" as const };
}

/** Der letzte Stand vor einem Anfang plus spätere Änderungen; alle Zeit- und
 * Sequenzgrenzen werden im selben Weltmutex wie Haltbelege gelesen. */
export async function loadPopulationDataHistory(db: IdentityDatabase, worldId: string, baseReleaseId: string,
  afterRevision: number, throughWorldSequence: number, initialAtMs?: number): Promise<readonly PopulationDataEvent[]> {
  const predicate = and(eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, DEMAND_POPULATION_EVENT),
    eq(sql<string>`${domainEvents.payload}->>'baseReleaseId'`, baseReleaseId), lte(domainEvents.sequence, throughWorldSequence));
  const events = await db.select().from(domainEvents).where(and(predicate,
    gt(sql<number>`(${domainEvents.payload}->>'sourceRevision')::bigint`, afterRevision),
    initialAtMs === undefined ? undefined : gt(sql<number>`(${domainEvents.payload}->'snapshot'->>'effectiveAtMs')::bigint`, initialAtMs)))
    .orderBy(asc(domainEvents.sequence)).limit(257);
  if (initialAtMs !== undefined) {
    const [initial] = await db.select().from(domainEvents).where(and(predicate,
      lte(sql<number>`(${domainEvents.payload}->'snapshot'->>'effectiveAtMs')::bigint`, initialAtMs)))
      .orderBy(desc(domainEvents.sequence)).limit(1);
    if (initial !== undefined) events.unshift(initial);
  }
  if (events.length > 256) throw new DemandError(503, "Zu viele Einwohnerkorrekturen in einem Nachfragefenster.");
  const result = events.map((event) => ({ worldSequence: event.sequence, snapshot: eventValue(event.payload, worldId, baseReleaseId) }));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index]!.snapshot.revision <= result[index - 1]!.snapshot.revision || result[index]!.snapshot.effectiveAtMs < result[index - 1]!.snapshot.effectiveAtMs)
      throw new DemandError(503, "Einwohnerkorrekturen besitzen keine monotone Daten- und Zeitfolge.");
  }
  return result;
}

export function populationRevisionOf(input: Readonly<Record<string, unknown>>): PopulationRevision | undefined {
  return input["populationRevision"] === undefined ? undefined : demandRecord(input["populationRevision"]) as unknown as PopulationRevision;
}
