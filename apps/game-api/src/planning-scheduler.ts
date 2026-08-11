import {
  consumePendingPlanningCommands,
  type PlanningDatabase,
  type PlanningInfrastructureReleaseCatalog,
} from "@zugfolge/planning-worker";
import type { PlanningRuntime } from "@zugfolge/planning-runtime-native";

import { compareUtf8 } from "./utf8.js";

/**
 * Runs one bounded, deterministic pass over the configured worlds.
 * Platform time is supplied explicitly and is never read inside the worker.
 */
export async function consumePlanningWorlds(
  db: PlanningDatabase,
  runtime: PlanningRuntime,
  infrastructureReleases: PlanningInfrastructureReleaseCatalog,
  worldIds: readonly string[],
  committedAt: Date,
  limitPerWorld = 100,
): Promise<number> {
  if (Number.isNaN(committedAt.getTime())) throw new RangeError("Planning-Commitzeit ist ungueltig.");
  if (!Number.isSafeInteger(limitPerWorld) || limitPerWorld < 1 || limitPerWorld > 1_000) {
    throw new RangeError("Planning-Consumer-Limit ist ungueltig.");
  }
  const orderedWorlds = [...new Set(worldIds)].sort(compareUtf8);
  let processed = 0;
  for (const worldId of orderedWorlds) {
    if (worldId.length === 0) throw new RangeError("Planning-Consumer erhielt eine leere Weltkennung.");
    const results = await consumePendingPlanningCommands(
      db,
      runtime,
      infrastructureReleases,
      worldId,
      { committedAt: () => committedAt, limit: limitPerWorld },
    );
    processed += results.length;
  }
  return processed;
}

export interface PlanningSchedulerOptions {
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export interface PlanningScheduler {
  readonly start: () => void;
  readonly close: () => Promise<void>;
}

/** Non-overlapping production poller whose close waits for the active pass. */
export function createPlanningScheduler(
  db: PlanningDatabase,
  runtime: PlanningRuntime,
  infrastructureReleases: PlanningInfrastructureReleaseCatalog,
  worldIds: readonly string[],
  options: PlanningSchedulerOptions = {},
): PlanningScheduler {
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError("Planning-Scheduler-Intervall ist ungueltig.");
  }
  const configuredWorldIds = Object.freeze([...worldIds]);
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  let cycle: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const run = () => {
    if (closed || cycle !== undefined) return;
    cycle = Promise.resolve()
      .then(() => consumePlanningWorlds(
        db,
        runtime,
        infrastructureReleases,
        configuredWorldIds,
        now(),
      ))
      .then(() => undefined)
      .catch(onError)
      .finally(() => {
        cycle = undefined;
      });
  };

  return Object.freeze({
    start() {
      if (closed || interval !== undefined) return;
      run();
      interval = setInterval(run, intervalMs);
      interval.unref();
    },
    async close() {
      if (closed) return;
      closed = true;
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      await cycle;
    },
  });
}
