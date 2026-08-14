import type {
  RegionalSimulationWorker,
  RegionalSimulationWorkBatch,
} from "./regional-simulation-worker.js";
import type { RegionalScheduledCommand } from "./boundary-transition-scheduler.js";
import { compareUtf8 } from "./utf8.js";

export interface RegionalScheduledCommandCatalog {
  at(worldId: string, regionId: string, atS: number): readonly RegionalScheduledCommand[];
  due(worldId: string, regionId: string, afterS: number, throughS: number): readonly RegionalScheduledCommand[];
}

type RegionalSimulationAdvancer = Pick<
  RegionalSimulationWorker,
  "applyBatch" | "readyRegions" | "recover"
>;

const TARGET_BATCH_COMMANDS = 2_000;

interface TimedRegionalSimulationWork {
  readonly atS: number;
  readonly command: RegionalSimulationWorkBatch["commands"][number];
}

export interface RegionalRealtimeRegistration {
  readonly worldId: string;
  readonly regionId: string;
}

function registrationKey(registration: RegionalRealtimeRegistration): string {
  return `${registration.worldId}\u0000${registration.regionId}`;
}

function chunkWithoutSplittingBoundary(
  commands: readonly TimedRegionalSimulationWork[],
  targetSize = TARGET_BATCH_COMMANDS,
): readonly (readonly TimedRegionalSimulationWork[])[] {
  if (!Number.isSafeInteger(targetSize) || targetSize <= 0) {
    throw new RangeError("Scheduler-Batchgroesse muss eine positive Ganzzahl sein.");
  }
  const chunks: TimedRegionalSimulationWork[][] = [];
  let current: TimedRegionalSimulationWork[] = [];
  let index = 0;
  while (index < commands.length) {
    const atS = commands[index]!.atS;
    let groupEnd = index + 1;
    while (groupEnd < commands.length && commands[groupEnd]!.atS === atS) groupEnd += 1;
    const group = commands.slice(index, groupEnd);
    if (current.length > 0 && current.length + group.length > targetSize) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
    if (current.length >= targetSize) {
      chunks.push(current);
      current = [];
    }
    index = groupEnd;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

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
 * Ein deterministischer 1:1-Takt ausschliesslich ueber explizit registrierte
 * Echtzeitregionen. Restaurierte Tutorial- oder Testregionen bleiben inert.
 * Fehler einer Region werden gesammelt, nachdem alle anderen Regionen ihren
 * Takt erhalten haben; ein fehlender Weltvertrag bleibt damit trotzdem hart.
 */
export async function advanceRegionalSimulations(
  worker: RegionalSimulationAdvancer,
  registrations: readonly RegionalRealtimeRegistration[],
  worldEpochs: ReadonlyMap<string, Date>,
  at: Date,
  boundaryTransitions?: RegionalScheduledCommandCatalog,
): Promise<number> {
  let advanced = 0;
  const readyByKey = new Map(
    worker.readyRegions().map((region) => [registrationKey(region), region] as const),
  );
  const registered = [...new Map(
    registrations.map((registration) => [registrationKey(registration), registration] as const),
  ).values()].sort(
    (left, right) =>
      compareUtf8(left.worldId, right.worldId) ||
      compareUtf8(left.regionId, right.regionId),
  );
  const failures: unknown[] = [];

  for (const registration of registered) {
    try {
      const key = registrationKey(registration);
      const region = readyByKey.get(key) ?? await worker.recover(
        registration.worldId,
        registration.regionId,
      );
      if (registrationKey(region) !== key) {
        throw new Error(
          `Recovery lieferte eine fremde regionale Simulation fuer '${registration.worldId}/${registration.regionId}'.`,
        );
      }
      readyByKey.set(key, region);
      const epoch = worldEpochs.get(region.worldId);
      if (epoch === undefined) {
        throw new Error(
          `Welt-Epoche fuer regionale Simulation '${region.worldId}' fehlt.`,
        );
      }
      const atS = regionalSimulationSecond(epoch, at);
      if (atS === undefined) continue;

      // Replays bei `nowS` schliessen das Commitfenster alter Einzelbefehle.
      // Neue Chunks schneiden niemals innerhalb einer atS-Gruppe: Advance und
      // alle fachlichen Befehle derselben Grenze committen dadurch atomar.
      const pending: TimedRegionalSimulationWork[] = [];
      for (const transition of boundaryTransitions?.at(
        region.worldId,
        region.regionId,
        region.nowS,
      ) ?? []) {
        pending.push({
          atS: transition.atS,
          command: {
            commandId: transition.transitionId,
            command: transition.command,
          },
        });
      }
      let cursorS = region.nowS;
      if (atS > region.nowS) {
        for (const transition of boundaryTransitions?.due(
          region.worldId,
          region.regionId,
          region.nowS,
          atS,
        ) ?? []) {
          if (transition.atS > cursorS) {
            pending.push({
              atS: transition.atS,
              command: {
                commandId: `advance-to:${transition.atS}`,
                command: { type: "advance-to", atS: transition.atS },
              },
            });
            cursorS = transition.atS;
          }
          pending.push({
            atS: transition.atS,
            command: {
            commandId: transition.transitionId,
            command: transition.command,
          },
          });
        }
        if (cursorS < atS) {
          pending.push({
            atS,
            command: {
              commandId: `advance-to:${atS}`,
              command: { type: "advance-to", atS },
            },
          });
        }
      }
      for (const chunk of chunkWithoutSplittingBoundary(pending)) {
        await worker.applyBatch(
          {
            worldId: region.worldId,
            regionId: region.regionId,
            commands: chunk.map((item) => item.command),
          },
          at,
        );
      }
      if (atS > region.nowS) {
        advanced += 1;
      }
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `${failures.length} regionale 1:1-Simulationstakte sind fehlgeschlagen.`,
    );
  }
  return advanced;
}
