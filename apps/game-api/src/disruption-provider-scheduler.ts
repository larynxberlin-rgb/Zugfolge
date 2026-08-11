import {
  disruptionProviderSnapshots,
  disruptionProviderStates,
  worlds,
  type Database,
} from "@zugfolge/db";
import {
  PROVIDER_SET_ID,
  PROVIDER_STALE_AFTER_MS,
  type ProviderSnapshot,
  type PublicInfrastructureRestrictionsClient,
} from "@zugfolge/disruption-provider";
import type { HealthCheck } from "@zugfolge/health";
import { and, asc, eq } from "drizzle-orm";

export interface EnabledProviderWorld {
  readonly worldId: string;
  readonly epoch: Date;
}

export interface DisruptionProviderStore {
  enabledWorlds(): Promise<readonly EnabledProviderWorld[]>;
  persistSuccess(world: EnabledProviderWorld, snapshot: ProviderSnapshot, checkedAt: Date): Promise<void>;
  persistFailure(worldId: string, reason: string, checkedAt: Date): Promise<void>;
}

export type DisruptionProviderConsumer = (world: EnabledProviderWorld, snapshot: ProviderSnapshot, checkedAt: Date) => Promise<void>;

function sanitizedFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 1_000);
  return "Providerabruf fehlgeschlagen";
}

function worldSecond(epoch: Date, at: Date): number {
  return Math.max(0, Math.floor((at.getTime() - epoch.getTime()) / 1_000));
}

export function createDisruptionProviderStore(db: Database): DisruptionProviderStore {
  return {
    async enabledWorlds() {
      return db.select({ worldId: disruptionProviderStates.worldId, epoch: worlds.epoch })
        .from(disruptionProviderStates)
        .innerJoin(worlds, eq(worlds.id, disruptionProviderStates.worldId))
        .where(and(
          eq(disruptionProviderStates.providerSetId, PROVIDER_SET_ID),
          eq(disruptionProviderStates.rightsStatus, "approved"),
          eq(disruptionProviderStates.enabled, "enabled"),
        ))
        .orderBy(asc(disruptionProviderStates.worldId));
    },
    async persistSuccess(world, snapshot, checkedAt) {
      await db.transaction(async (tx) => {
        await tx.insert(disruptionProviderSnapshots).values({
          worldId: world.worldId,
          providerSetId: PROVIDER_SET_ID,
          snapshotHash: snapshot.snapshotHash,
          providerRevision: snapshot.revision,
          sourceVersion: snapshot.sourceVersion,
          fetchedAt: new Date(snapshot.fetchedAt),
          rawSnapshot: snapshot.raw,
          normalizedSnapshot: {
            schemaVersion: snapshot.schemaVersion,
            restrictions: snapshot.restrictions,
            discarded: snapshot.discarded,
            sourceDataTimestamps: snapshot.sourceDataTimestamps,
          },
          acceptedCount: snapshot.restrictions.length,
          discardedCount: snapshot.discarded.length,
        }).onConflictDoNothing({
          target: [
            disruptionProviderSnapshots.worldId,
            disruptionProviderSnapshots.providerSetId,
            disruptionProviderSnapshots.snapshotHash,
          ],
        });
        await tx.update(disruptionProviderStates).set({
          lastSafeAtS: worldSecond(world.epoch, new Date(snapshot.fetchedAt)),
          lastSafeSnapshot: {
            schemaVersion: snapshot.schemaVersion,
            snapshotHash: snapshot.snapshotHash,
            revision: snapshot.revision,
            fetchedAt: snapshot.fetchedAt,
          },
          lastFailure: null,
          checkedAt,
        }).where(and(
          eq(disruptionProviderStates.worldId, world.worldId),
          eq(disruptionProviderStates.providerSetId, PROVIDER_SET_ID),
        ));
      });
    },
    async persistFailure(worldId, reason, checkedAt) {
      await db.update(disruptionProviderStates).set({ lastFailure: reason, checkedAt }).where(and(
        eq(disruptionProviderStates.worldId, worldId),
        eq(disruptionProviderStates.providerSetId, PROVIDER_SET_ID),
      ));
    },
  };
}

export interface DisruptionProviderMonitorSnapshot {
  readonly startedAtMs: number;
  readonly enabledWorlds: number;
  readonly running: boolean;
  readonly lastStartedAtMs?: number;
  readonly lastCompletedAtMs?: number;
  readonly lastSuccessfulSnapshotAtMs?: number;
  readonly lastFailureAtMs?: number;
}

export class DisruptionProviderMonitor {
  #value: DisruptionProviderMonitorSnapshot;

  constructor(startedAtMs: number) {
    this.#value = { startedAtMs, enabledWorlds: 0, running: false };
  }

  started(atMs: number, enabledWorlds: number): void {
    this.#value = { ...this.#value, lastStartedAtMs: atMs, enabledWorlds, running: true };
  }

  completed(atMs: number, successful: boolean): void {
    this.#value = {
      ...this.#value,
      lastCompletedAtMs: atMs,
      lastSuccessfulSnapshotAtMs: successful ? atMs : this.#value.lastSuccessfulSnapshotAtMs,
      running: false,
    };
  }

  failed(atMs: number): void {
    this.#value = { ...this.#value, lastCompletedAtMs: atMs, lastFailureAtMs: atMs, running: false };
  }

  snapshot(): DisruptionProviderMonitorSnapshot {
    return Object.freeze({ ...this.#value });
  }
}

export function createDisruptionProviderHealthCheck(
  monitor: DisruptionProviderMonitor,
  now: () => number = Date.now,
): HealthCheck {
  return {
    name: "disruption-provider",
    async check() {
      const state = monitor.snapshot();
      if (state.enabledWorlds === 0) return { status: "ok", code: "provider_idle" };
      if (state.running && state.lastStartedAtMs !== undefined && now() - state.lastStartedAtMs > 120_000) {
        return { status: "down", code: "provider_stuck" };
      }
      if (state.lastSuccessfulSnapshotAtMs === undefined) return { status: "degraded", code: "provider_starting" };
      const ageMs = Math.max(0, now() - state.lastSuccessfulSnapshotAtMs);
      if (ageMs > PROVIDER_STALE_AFTER_MS) return { status: "down", code: "provider_snapshot_stale", detail: `Letzter sicherer Stand vor ${Math.round(ageMs / 60_000)} min` };
      if (state.lastFailureAtMs !== undefined && state.lastFailureAtMs > state.lastSuccessfulSnapshotAtMs) {
        return { status: "degraded", code: "provider_last_safe", detail: "Letzter sicherer Stand bleibt aktiv" };
      }
      return { status: "ok", code: "provider_current" };
    },
  };
}

export async function runDisruptionProviderCycle(
  client: Pick<PublicInfrastructureRestrictionsClient, "fetchSnapshot">,
  store: DisruptionProviderStore,
  monitor: DisruptionProviderMonitor,
  now: Date,
  consume: DisruptionProviderConsumer = async () => undefined,
): Promise<{ readonly worlds: number; readonly fetched: boolean }> {
  if (Number.isNaN(now.getTime())) throw new RangeError("Provider-Laufzeitpunkt ist ungueltig.");
  const enabledWorlds = await store.enabledWorlds();
  monitor.started(now.getTime(), enabledWorlds.length);
  if (enabledWorlds.length === 0) {
    monitor.completed(now.getTime(), false);
    return { worlds: 0, fetched: false };
  }
  try {
    const snapshot = await client.fetchSnapshot(now);
    for (const world of enabledWorlds) {
      await consume(world, snapshot, now);
      await store.persistSuccess(world, snapshot, now);
    }
    monitor.completed(now.getTime(), true);
    return { worlds: enabledWorlds.length, fetched: true };
  } catch (error) {
    const reason = sanitizedFailure(error);
    await Promise.all(enabledWorlds.map((world) => store.persistFailure(world.worldId, reason, now)));
    monitor.failed(now.getTime());
    throw error;
  }
}
