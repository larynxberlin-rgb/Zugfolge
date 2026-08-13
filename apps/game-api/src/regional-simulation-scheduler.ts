import type { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import type { RegionalScheduledCommand } from "./boundary-transition-scheduler.js";

export interface RegionalScheduledCommandCatalog {
  due(worldId: string, regionId: string, afterS: number, throughS: number): readonly RegionalScheduledCommand[];
}

type RegionalSimulationAdvancer = Pick<
  RegionalSimulationWorker,
  "apply" | "readyRegions"
>;

/** Explizite Weltsekunde aus Welt-Epoche und Plattformzeit. */
export function regionalSimulationSecond(
  epoch: Date,
  at: Date,
): number | undefined {
  const epochMs = epoch.getTime();
  const atMs = at.getTime();
  if (Number.isNaN(epochMs) || Number.isNaN(atMs)) {
    throw new RangeError("Welt-Epoche oder Schedulerzeit ist ungueltig.");
  }
  const elapsedMs = atMs - epochMs;
  if (elapsedMs < 0) return undefined;
  const atS = Math.floor(elapsedMs / 1_000);
  if (!Number.isSafeInteger(atS)) {
    throw new RangeError("Explizite Weltsekunde liegt ausserhalb des sicheren Bereichs.");
  }
  return atS;
}

/**
 * Ein deterministischer 1:1-Takt ueber alle im Prozess restaurierten Regionen.
 * Der Kern erhaelt ausschliesslich die hier explizit berechnete Weltsekunde.
 */
export async function advanceRegionalSimulations(
  worker: RegionalSimulationAdvancer,
  worldEpochs: ReadonlyMap<string, Date>,
  at: Date,
  boundaryTransitions?: RegionalScheduledCommandCatalog,
): Promise<number> {
  let advanced = 0;
  for (const region of worker.readyRegions()) {
    const epoch = worldEpochs.get(region.worldId);
    if (epoch === undefined) {
      throw new Error(
        `Welt-Epoche fuer regionale Simulation '${region.worldId}' fehlt.`,
      );
    }
    const atS = regionalSimulationSecond(epoch, at);
    if (atS === undefined || atS <= region.nowS) continue;
    let cursorS = region.nowS;
    for (const transition of boundaryTransitions?.due(region.worldId, region.regionId, region.nowS, atS) ?? []) {
      if (transition.atS > cursorS) {
        await worker.apply(
          {
            worldId: region.worldId,
            regionId: region.regionId,
            commandId: `advance-to:${transition.atS}`,
            command: { type: "advance-to", atS: transition.atS },
          },
          at,
        );
        cursorS = transition.atS;
      }
      await worker.apply(
        {
          worldId: region.worldId,
          regionId: region.regionId,
          commandId: transition.transitionId,
          command: transition.command,
        },
        at,
      );
    }
    if (cursorS >= atS) {
      advanced += 1;
      continue;
    }
    await worker.apply(
      {
        worldId: region.worldId,
        regionId: region.regionId,
        commandId: `advance-to:${atS}`,
        command: { type: "advance-to", atS },
      },
      at,
    );
    advanced += 1;
  }
  return advanced;
}
