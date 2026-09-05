import { createHash } from "node:crypto";
import { canonicalJson } from "@zugfolge/commerce";
import { domainEvents, regionalSimulationStates, worlds, type Database } from "@zugfolge/db";
import { OPERATIONAL_SIMULATION_COMMAND_SCHEMA, type OperationalSimulationRuntime, type OperationalSimulationState } from "@zugfolge/runtime-native";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { ManualDisruptionAdminError, type ManualDisruptionAdminResult, type ManualDisruptionSchedule } from "./manual-disruption-admin.js";
import type { OperationalScheduledCommand, OperationalScheduledCommandBoundary, RegionalScheduledCommandCatalog } from "./regional-simulation-scheduler.js";
import { compareUtf8 } from "./utf8.js";

interface RegionBinding { readonly worldId: string; readonly regionId: string; readonly initializationHash: string; readonly nowMs?: number }
interface SchedulePlan {
  readonly schemaVersion: "zugfolge-manual-disruption-schedule/v1";
  readonly worldId: string;
  readonly effectKey: string;
  readonly commandHash: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly regions: readonly { readonly regionId: string; readonly initializationHash: string; readonly commands: readonly OperationalScheduledCommand[] }[];
}
const EVENT_TYPE = "disruption.manual-scheduled";
const key = (worldId: string, regionId: string) => `${worldId}\u0000${regionId}`;
const order = (left: OperationalScheduledCommand, right: OperationalScheduledCommand) => left.atMs - right.atMs
  || (left.command.type === "clear-disruption" ? 0 : 1) - (right.command.type === "clear-disruption" ? 0 : 1)
  || compareUtf8(left.commandId, right.commandId);

/** Persistente manuelle Zeitgrenzen teilen den Single-Writer-Takt mit dem Fahrplan. */
export class ManualDisruptionCommandCatalog implements RegionalScheduledCommandCatalog {
  readonly #db: Database;
  readonly #base: RegionalScheduledCommandCatalog;
  readonly #runtime: Pick<OperationalSimulationRuntime, "restore" | "apply">;
  readonly #regions: () => readonly RegionBinding[];
  readonly #commands = new Map<string, readonly OperationalScheduledCommand[]>();
  #pending: Promise<unknown> = Promise.resolve();

  constructor(options: { readonly db: Database; readonly base: RegionalScheduledCommandCatalog;
    readonly runtime: Pick<OperationalSimulationRuntime, "restore" | "apply">; readonly regions: () => readonly RegionBinding[] }) {
    this.#db = options.db; this.#base = options.base; this.#runtime = options.runtime; this.#regions = options.regions;
  }

  /** Snapshot, Advance und neue Annahme duerfen sich nicht gegenseitig ueberholen. */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation);
    this.#pending = result.catch(() => undefined);
    return result;
  }

  async schedule(input: ManualDisruptionSchedule): Promise<ManualDisruptionAdminResult> {
    return this.exclusive(async () => {
      const { context } = input;
      const worldId = context.payload.worldId;
      const effectKey = context.effectIdempotencyKey ?? context.commandId;
      const commandHash = createHash("sha256").update(canonicalJson(context.payload)).digest("hex");
      const [previous] = await this.#db.select().from(domainEvents).where(and(eq(domainEvents.worldId, worldId),
        eq(domainEvents.eventType, EVENT_TYPE), sql`${domainEvents.payload}->>'effectKey' = ${effectKey}`)).limit(1);
      if (previous !== undefined) {
        const plan = previous.payload as SchedulePlan;
        if (plan.commandHash !== commandHash) throw new ManualDisruptionAdminError("effect");
        context.markEffectApplied?.();
        return this.#result(previous.id, plan);
      }
      const [world] = await this.#db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1);
      if (world === undefined || world.lifecycleStatus !== "active") throw new ManualDisruptionAdminError("authorization");
      const originalStartMs = input.startsAt.getTime() - world.epoch.getTime();
      const endsAtMs = input.endsAt.getTime() - world.epoch.getTime();
      let startsAtMs = Math.max(originalStartMs, context.now.getTime() - world.epoch.getTime());
      const regions = [...new Set(input.targets.map((target) => target.regionId))].sort(compareUtf8);
      const rows: { row: typeof regionalSimulationStates.$inferSelect; commands: OperationalScheduledCommand[] }[] = [];
      for (const regionId of regions) {
        const binding = this.#regions().find((entry) => entry.worldId === worldId && entry.regionId === regionId);
        const [row] = await this.#db.select().from(regionalSimulationStates).where(and(
          eq(regionalSimulationStates.worldId, worldId), eq(regionalSimulationStates.regionId, regionId),
        )).limit(1);
        if (binding === undefined || row === undefined || row.initializationHash !== binding.initializationHash) throw new ManualDisruptionAdminError("resources");
        let state = this.#runtime.restore(row.state as OperationalSimulationState, binding.initializationHash).state;
        if (state.world.worldId !== worldId || state.world.regionId !== regionId || state.initializationHash !== binding.initializationHash) throw new ManualDisruptionAdminError("resources");
        startsAtMs = Math.max(startsAtMs, state.world.nowMs);
        const commands: OperationalScheduledCommand[] = [];
        for (const [index, target] of input.targets.entries()) {
          if (target.regionId !== regionId) continue;
          const disruptionId = `manual:${effectKey}:${index}`;
          const activate = { type: "activate-disruption" as const, disruptionId, effect: target.effect };
          const clear = { type: "clear-disruption" as const, disruptionId, releaseReference: `manual:${effectKey}:authorized-expiry` };
          // Reine native Vorschau: keine Persistenz und kein zweiter Betriebswriter.
          for (const [suffix, command] of [["activate", activate], ["clear", clear]] as const) {
            const applied = await this.#runtime.apply(state, { schemaVersion: OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
              worldId, regionId, commandId: `manual-preview:${effectKey}:${index}:${suffix}`, expectedStateHash: state.stateHash,
              expectedRevision: state.revision, expectedPublisherSequence: state.publisherSequence, command });
            state = applied.state;
          }
          commands.push({ atMs: 0, commandId: `${disruptionId}:activate`, command: activate },
            { atMs: endsAtMs, commandId: `${disruptionId}:clear`, command: clear });
        }
        rows.push({ row, commands });
      }
      if (![originalStartMs, startsAtMs, endsAtMs].every(Number.isSafeInteger) || originalStartMs < 0 || startsAtMs < 0 || endsAtMs <= startsAtMs) throw new ManualDisruptionAdminError("time");
      const plan: SchedulePlan = { schemaVersion: "zugfolge-manual-disruption-schedule/v1", worldId, effectKey, commandHash, startsAtMs, endsAtMs,
        regions: rows.map(({ row, commands }) => ({ regionId: row.regionId, initializationHash: row.initializationHash!,
          commands: commands.map((command) => command.command.type === "activate-disruption" ? { ...command, atMs: startsAtMs } : command) })) };
      const saved = await this.#db.transaction(async (tx) => {
        const [lockedWorld] = await tx.select().from(worlds).where(eq(worlds.id, worldId)).limit(1).for("update");
        if (lockedWorld?.lifecycleStatus !== "active" || lockedWorld.epoch.getTime() !== world.epoch.getTime()) throw new ManualDisruptionAdminError("authorization");
        const [duplicate] = await tx.select().from(domainEvents).where(and(eq(domainEvents.worldId, worldId),
          eq(domainEvents.eventType, EVENT_TYPE), sql`${domainEvents.payload}->>'effectKey' = ${effectKey}`)).limit(1);
        if (duplicate !== undefined) {
          const previousPlan = duplicate.payload as SchedulePlan;
          if (previousPlan.commandHash !== commandHash) throw new ManualDisruptionAdminError("effect");
          return { id: duplicate.id, plan: previousPlan };
        }
        for (const { row } of rows) {
          const [current] = await tx.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, worldId), eq(regionalSimulationStates.regionId, row.regionId))).limit(1).for("update");
          if (current === undefined || current.stateHash !== row.stateHash || current.revision !== row.revision || current.initializationHash !== row.initializationHash) throw new ManualDisruptionAdminError("resources");
        }
        const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents).where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
        const [saved] = await tx.insert(domainEvents).values({ worldId, sequence: (head?.sequence ?? 0) + 1,
          eventType: EVENT_TYPE, payload: plan, occurredAt: context.now }).returning({ id: domainEvents.id });
        if (saved === undefined) throw new ManualDisruptionAdminError("effect");
        return { id: saved.id, plan };
      });
      context.markEffectApplied?.();
      return this.#result(saved.id, saved.plan);
    });
  }

  #result(id: string, plan: SchedulePlan): ManualDisruptionAdminResult {
    return { state: "completed", gameAuditEventId: id, result: { manualDisruptionStatus: "scheduled",
      effectiveStartsAtMs: plan.startsAtMs, endsAtMs: plan.endsAtMs, supportedTargetCount: plan.regions.reduce((sum, region) => sum + region.commands.length / 2, 0) } };
  }

  /** Aufruf im selben exklusiven Abschnitt wie der anschliessende Regionaltakt. */
  async refresh(): Promise<void> {
    const bindings = this.#regions();
    const commands = new Map<string, OperationalScheduledCommand[]>();
    for (const worldId of [...new Set(bindings.map((entry) => entry.worldId))].sort(compareUtf8)) {
      const minimumNow = Math.min(...bindings.filter((entry) => entry.worldId === worldId).map((entry) => entry.nowMs ?? 0));
      const rows = await this.#db.select().from(domainEvents).where(and(eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, EVENT_TYPE),
        sql`(${domainEvents.payload}->>'endsAtMs')::bigint >= ${minimumNow}`)).orderBy(asc(domainEvents.sequence));
      for (const row of rows) {
        const plan = row.payload as SchedulePlan;
        if (plan.schemaVersion !== "zugfolge-manual-disruption-schedule/v1" || plan.worldId !== worldId) throw new ManualDisruptionAdminError("schema");
        for (const region of plan.regions) {
          const binding = bindings.find((entry) => entry.worldId === worldId && entry.regionId === region.regionId);
          if (binding?.initializationHash !== region.initializationHash) throw new ManualDisruptionAdminError("resources");
          const regionKey = key(worldId, region.regionId);
          commands.set(regionKey, [...commands.get(regionKey) ?? [], ...region.commands]);
        }
      }
    }
    this.#commands.clear();
    for (const [regionKey, entries] of commands) this.#commands.set(regionKey, entries.sort(order));
  }

  at(worldId: string, regionId: string, atMs: number): readonly OperationalScheduledCommand[] {
    return [...this.#commands.get(key(worldId, regionId)) ?? []].filter((entry) => entry.atMs === atMs)
      .concat(this.#base.at(worldId, regionId, atMs));
  }

  *dueBoundaries(worldId: string, regionId: string, afterMs: number, throughMs: number): IterableIterator<OperationalScheduledCommandBoundary> {
    const manual = (this.#commands.get(key(worldId, regionId)) ?? []).filter((entry) => entry.atMs > afterMs && entry.atMs <= throughMs);
    let index = 0;
    for (const boundary of this.#base.dueBoundaries(worldId, regionId, afterMs, throughMs)) {
      while (index < manual.length && manual[index]!.atMs < boundary.atMs) {
        const atMs = manual[index]!.atMs; const entries = [];
        while (manual[index]?.atMs === atMs) entries.push(manual[index++]!);
        yield { atMs, commands: entries };
      }
      const entries: OperationalScheduledCommand[] = [];
      while (manual[index]?.atMs === boundary.atMs) entries.push(manual[index++]!);
      // Die Basis bewahrt materialize -> queue -> dispatch. Nur eigene
      // Freigaben/Aktivierungen liegen deterministisch davor.
      yield { atMs: boundary.atMs, commands: entries.concat(boundary.commands) };
    }
    while (index < manual.length) {
      const atMs = manual[index]!.atMs; const entries = [];
      while (manual[index]?.atMs === atMs) entries.push(manual[index++]!);
      yield { atMs, commands: entries };
    }
  }
}
