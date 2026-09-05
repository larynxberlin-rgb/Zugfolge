import { disruptionPolicies, type Database } from "@zugfolge/db";
import {
  OPERATIONAL_DAILY_RESTRICTIONS_SCHEMA,
  OPERATIONAL_DAY_MS,
  type OperationalDailyRestrictionPolicy,
  type OperationalDailyRestrictionsGenerated,
  type OperationalDailyRestrictionsRequest,
  type OperationalInfrastructureBinding,
} from "@zugfolge/runtime-native";
import { asc, eq } from "drizzle-orm";
import type { OperationalScheduledCommand, OperationalScheduledCommandBoundary, RegionalScheduledCommandCatalog } from "./regional-simulation-scheduler.js";
import { compareUtf8 } from "./utf8.js";

export interface DailyRestrictionWorldSource {
  readonly worldId: string;
  readonly regionId: string;
  readonly seed: string;
  readonly infraRelease: OperationalInfrastructureBinding;
  readonly routeVersionIds: readonly string[];
}

export interface DailyRestrictionDiagnostics {
  readonly status: "missing-policy" | "manual" | "ready" | "partially-supported";
  readonly worldId: string;
  readonly regionId: string;
  readonly dayStartMs: number;
  readonly policyVersion: number | null;
  readonly restrictions: OperationalDailyRestrictionsGenerated["restrictions"];
  readonly unsupportedRestrictions: OperationalDailyRestrictionsGenerated["unsupportedRestrictions"];
}

function milliseconds(seconds: number): number {
  const value = seconds * 1_000;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("La-Policyzeit ist keine gueltige Weltzeit.");
  return value;
}

/** Historische Versionen bleiben fuer Restart, Ablauf und Catch-up lesbar. */
export function createDailyRestrictionPolicyLoader(db: Database) {
  return async (worldId: string): Promise<readonly OperationalDailyRestrictionPolicy[]> => {
    const rows = await db.select().from(disruptionPolicies)
      .where(eq(disruptionPolicies.worldId, worldId))
      .orderBy(asc(disruptionPolicies.validFromS), asc(disruptionPolicies.version));
    return rows.map((row) => {
      if (!["scheduled", "active", "superseded"].includes(row.status)
        || typeof row.simulationProfile !== "object" || row.simulationProfile === null
        || Array.isArray(row.simulationProfile)) throw new Error("La-Policy besitzt keinen veroeffentlichten Generatorvertrag.");
      return {
        version: row.version,
        plannedWorksMode: row.plannedWorksMode,
        operationalIncidentMode: row.operationalIncidentMode,
        providerSetId: row.providerSetId,
        simulationProfile: row.simulationProfile as Readonly<Record<string, unknown>>,
        rulesetVersion: row.rulesetVersion,
        validFromMs: milliseconds(row.validFromS),
        validUntilMs: row.validUntilS === null ? null : milliseconds(row.validUntilS),
      };
    });
  };
}

const sourceKey = (worldId: string, regionId: string): string => `${worldId}\u0000${regionId}`;

/** M8-Tagesmodell und Zugfahrplan teilen denselben Single-Writer-Zeitkatalog. */
export class DailyRestrictionCommandCatalog implements RegionalScheduledCommandCatalog {
  readonly #base: RegionalScheduledCommandCatalog;
  readonly #generate: (input: OperationalDailyRestrictionsRequest) => OperationalDailyRestrictionsGenerated;
  readonly #loadPolicies: (worldId: string) => Promise<readonly OperationalDailyRestrictionPolicy[]>;
  readonly #sources = new Map<string, DailyRestrictionWorldSource>();
  readonly #policies = new Map<string, readonly OperationalDailyRestrictionPolicy[]>();
  readonly #cache = new Map<string, Map<number, OperationalDailyRestrictionsGenerated | undefined>>();
  readonly #diagnostics = new Map<string, DailyRestrictionDiagnostics>();

  constructor(options: {
    readonly base: RegionalScheduledCommandCatalog;
    readonly generate: (input: OperationalDailyRestrictionsRequest) => OperationalDailyRestrictionsGenerated;
    readonly loadPolicies: (worldId: string) => Promise<readonly OperationalDailyRestrictionPolicy[]>;
  }) {
    this.#base = options.base;
    this.#generate = options.generate;
    this.#loadPolicies = options.loadPolicies;
  }

  /** Nur explizit veroeffentlichte Policies, niemals ein impliziter Startmodus. */
  async refresh(sources: readonly DailyRestrictionWorldSource[]): Promise<void> {
    const next = new Map(sources.map((source) => [sourceKey(source.worldId, source.regionId), source]));
    const policies = new Map<string, readonly OperationalDailyRestrictionPolicy[]>();
    const changedPolicies = new Set<string>();
    for (const worldId of [...new Set(sources.map((source) => source.worldId))].sort(compareUtf8)) {
      const loaded = [...await this.#loadPolicies(worldId)].sort((left, right) => left.validFromMs - right.validFromMs || left.version - right.version);
      if (new Set(loaded.map((policy) => policy.version)).size !== loaded.length) throw new Error("La-Policyversion ist nicht eindeutig.");
      policies.set(worldId, loaded);
      if (JSON.stringify(this.#policies.get(worldId)) !== JSON.stringify(loaded)) changedPolicies.add(worldId);
    }
    for (const [key, source] of next) {
      const previous = this.#sources.get(key);
      if ((previous !== source && JSON.stringify(previous) !== JSON.stringify(source)) || changedPolicies.has(source.worldId)) {
        this.#cache.delete(key);
      }
    }
    for (const key of this.#sources.keys()) {
      if (!next.has(key)) { this.#cache.delete(key); this.#diagnostics.delete(key); }
    }
    this.#sources.clear();
    for (const [key, source] of next) this.#sources.set(key, source);
    this.#policies.clear();
    for (const [worldId, values] of policies) this.#policies.set(worldId, values);
  }

  diagnostics(worldId: string): readonly DailyRestrictionDiagnostics[] {
    return [...this.#diagnostics.values()].filter((value) => value.worldId === worldId)
      .sort((left, right) => compareUtf8(left.regionId, right.regionId));
  }

  validatePolicy(worldId: string, policy: OperationalDailyRestrictionPolicy): void {
    if (!Number.isSafeInteger(policy.validFromMs) || policy.validFromMs < 0
      || policy.validFromMs % OPERATIONAL_DAY_MS !== 0
      || (policy.validUntilMs !== null && (!Number.isSafeInteger(policy.validUntilMs) || policy.validUntilMs <= policy.validFromMs))) {
      throw new Error("La-Policy besitzt keine gueltige Tages- und Ablaufbindung.");
    }
    const sources = [...this.#sources.values()].filter((source) => source.worldId === worldId);
    if (sources.length === 0) throw new Error("La-Policy besitzt keine aktive signierte Operational-Weltbindung.");
    if (policy.plannedWorksMode === "MANUAL" && policy.operationalIncidentMode === "MANUAL") return;
    for (const source of sources) this.#generate({
      schemaVersion: OPERATIONAL_DAILY_RESTRICTIONS_SCHEMA,
      ...source,
      dayStartMs: policy.validFromMs,
      policy,
    });
  }

  #day(worldId: string, regionId: string, dayStartMs: number): OperationalDailyRestrictionsGenerated | undefined {
    const key = sourceKey(worldId, regionId);
    const source = this.#sources.get(key);
    if (source === undefined) return undefined;
    let cache = this.#cache.get(key);
    if (cache?.has(dayStartMs)) return cache.get(dayStartMs);
    if (cache === undefined) { cache = new Map(); this.#cache.set(key, cache); }
    const latest = [...this.#policies.get(worldId) ?? []].reverse().find((value) => value.validFromMs <= dayStartMs);
    const policy = latest?.validUntilMs !== null && latest?.validUntilMs !== undefined && dayStartMs >= latest.validUntilMs ? undefined : latest;
    const manual = policy?.plannedWorksMode === "MANUAL" && policy.operationalIncidentMode === "MANUAL";
    const generated = policy === undefined || manual ? undefined : this.#generate({
      schemaVersion: OPERATIONAL_DAILY_RESTRICTIONS_SCHEMA,
      ...source,
      dayStartMs,
      policy,
    });
    const previous = this.#diagnostics.get(key);
    if (previous === undefined || dayStartMs >= previous.dayStartMs) this.#diagnostics.set(key, {
      status: policy === undefined ? "missing-policy" : manual ? "manual"
        : (generated?.unsupportedRestrictions.length ?? 0) > 0 ? "partially-supported" : "ready",
      worldId, regionId, dayStartMs,
      policyVersion: policy?.version ?? null,
      restrictions: generated?.restrictions ?? [],
      unsupportedRestrictions: generated?.unsupportedRestrictions ?? [],
    });
    cache.set(dayStartMs, generated);
    while (cache.size > 3) cache.delete(cache.keys().next().value!);
    return generated;
  }

  *#dailyBoundaries(worldId: string, regionId: string, afterMs: number, throughMs: number): IterableIterator<OperationalScheduledCommandBoundary> {
    const firstDay = Math.max(0, Math.floor(afterMs / OPERATIONAL_DAY_MS));
    const lastDay = Math.floor(throughMs / OPERATIONAL_DAY_MS);
    for (let day = firstDay; day <= lastDay; day += 1) {
      const lower = day * OPERATIONAL_DAY_MS;
      const upper = (day + 1) * OPERATIONAL_DAY_MS;
      const boundaries = new Map<number, OperationalScheduledCommand[]>();
      for (let origin = Math.max(0, day - 2); origin <= day; origin += 1) {
        const generated = this.#day(worldId, regionId, origin * OPERATIONAL_DAY_MS);
        for (const restriction of generated?.restrictions ?? []) {
          const prefix = `daily:${generated!.policyVersion}:${restriction.disruptionId}`;
          for (const entry of [
            { atMs: restriction.startsAtMs, commandId: `${prefix}:activate`, command: { type: "activate-disruption" as const, disruptionId: restriction.disruptionId, effect: restriction.effect } },
            { atMs: restriction.endsAtMs, commandId: `${prefix}:clear`, command: { type: "clear-disruption" as const, disruptionId: restriction.disruptionId, releaseReference: `${prefix}:expired` } },
          ]) {
            if (entry.atMs < lower || entry.atMs >= upper || entry.atMs <= afterMs || entry.atMs > throughMs) continue;
            const entries = boundaries.get(entry.atMs) ?? [];
            entries.push(entry);
            boundaries.set(entry.atMs, entries);
          }
        }
      }
      for (const [atMs, commands] of [...boundaries].sort(([left], [right]) => left - right)) {
        yield { atMs, commands: commands.sort((left, right) => {
          const leftClear = left.command.type === "clear-disruption" ? 0 : 1;
          const rightClear = right.command.type === "clear-disruption" ? 0 : 1;
          return leftClear - rightClear || compareUtf8(left.commandId, right.commandId);
        }) };
      }
    }
  }

  at(worldId: string, regionId: string, atMs: number): readonly OperationalScheduledCommand[] {
    return [...this.#dailyBoundaries(worldId, regionId, atMs - 1, atMs)].flatMap((entry) => entry.commands)
      .concat(this.#base.at(worldId, regionId, atMs));
  }

  *dueBoundaries(worldId: string, regionId: string, afterMs: number, throughMs: number): IterableIterator<OperationalScheduledCommandBoundary> {
    const base = this.#base.dueBoundaries(worldId, regionId, afterMs, throughMs)[Symbol.iterator]();
    const daily = this.#dailyBoundaries(worldId, regionId, afterMs, throughMs);
    let left = base.next();
    let right = daily.next();
    while (!left.done || !right.done) {
      if (right.done || (!left.done && left.value.atMs < right.value.atMs)) { yield left.value!; left = base.next(); }
      else if (left.done || right.value.atMs < left.value.atMs) { yield right.value; right = daily.next(); }
      else {
        yield { atMs: left.value.atMs, commands: [...right.value.commands, ...left.value.commands] };
        left = base.next(); right = daily.next();
      }
    }
  }
}
