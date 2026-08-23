import type { OperationalSimulationCommandPayload } from "@zugfolge/runtime-native";

import type {
  RegionalSimulationWorker,
  RegionalSimulationWorkBatch,
} from "./regional-simulation-worker.js";
import { compareUtf8 } from "./utf8.js";

export interface OperationalScheduledCommand {
  readonly commandId: string;
  readonly atMs: number;
  readonly command: OperationalSimulationCommandPayload;
}

export interface RegionalScheduledCommandCatalog {
  at(worldId: string, regionId: string, atMs: number): readonly OperationalScheduledCommand[];
  due(worldId: string, regionId: string, afterMs: number, throughMs: number): readonly OperationalScheduledCommand[];
}

type RegionalSimulationAdvancer = Pick<
  RegionalSimulationWorker,
  "applyBatch" | "readyRegions" | "recover"
>;

const TARGET_BATCH_COMMANDS = 2_000;

interface TimedRegionalSimulationWork {
  readonly atMs: number;
  readonly command: RegionalSimulationWorkBatch["commands"][number];
}

export interface RegionalRealtimeRegistration {
  readonly worldId: string;
  readonly regionId: string;
  /** Aus dem signierten Deployment kanonisch abgeleitete Restore-Bindung. */
  readonly initializationHash: string;
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
    const atMs = commands[index]!.atMs;
    let groupEnd = index + 1;
    while (groupEnd < commands.length && commands[groupEnd]!.atMs === atMs) groupEnd += 1;
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

/** Explizite Weltmillisekunde aus Weltepoche und Plattformzeit. */
export function regionalSimulationMillisecond(epoch: Date, at: Date): number | undefined {
  const epochMs = epoch.getTime();
  const atMs = at.getTime();
  if (Number.isNaN(epochMs) || Number.isNaN(atMs)) {
    throw new RangeError("Welt-Epoche oder Schedulerzeit ist ungueltig.");
  }
  const elapsedMs = atMs - epochMs;
  if (elapsedMs < 0) return undefined;
  if (!Number.isSafeInteger(elapsedMs)) {
    throw new RangeError("Explizite Weltmillisekunde liegt ausserhalb des sicheren Bereichs.");
  }
  return elapsedMs;
}

/** Beibehaltene öffentliche Hilfsfunktion an der Fahrplan-Sekundengrenze. */
export function regionalSimulationSecond(epoch: Date, at: Date): number | undefined {
  const atMs = regionalSimulationMillisecond(epoch, at);
  return atMs === undefined ? undefined : Math.floor(atMs / 1_000);
}

/**
 * Deterministischer 1:1-Takt der operativen v2-Single-Writer. Der Scheduler
 * übergibt ausschließlich explizite Millisekunden; alle Bewegungsgrenzen werden
 * im Rust-Kern ereignisgesteuert verarbeitet.
 */
export async function advanceRegionalSimulations(
  worker: RegionalSimulationAdvancer,
  registrations: readonly RegionalRealtimeRegistration[],
  worldEpochs: ReadonlyMap<string, Date>,
  at: Date,
  scheduledCommands?: RegionalScheduledCommandCatalog,
): Promise<number> {
  let advanced = 0;
  const readyByKey = new Map(
    worker.readyRegions().map((region) => [registrationKey(region), region] as const),
  );
  const registered = [...new Map(
    registrations.map((registration) => [registrationKey(registration), registration] as const),
  ).values()].sort(
    (left, right) => compareUtf8(left.worldId, right.worldId)
      || compareUtf8(left.regionId, right.regionId),
  );
  const failures: unknown[] = [];

  for (const registration of registered) {
    try {
      const key = registrationKey(registration);
      const ready = readyByKey.get(key);
      const region = ready?.initializationHash === registration.initializationHash
        ? ready
        : await worker.recover(
          registration.worldId,
          registration.regionId,
          registration.initializationHash,
        );
      if (
        registrationKey(region) !== key
        || region.initializationHash !== registration.initializationHash
      ) {
        throw new Error(
          `Recovery lieferte eine fremde oder falsch gebundene regionale Simulation fuer '${registration.worldId}/${registration.regionId}'.`,
        );
      }
      readyByKey.set(key, region);
      const epoch = worldEpochs.get(region.worldId);
      if (epoch === undefined) {
        throw new Error(`Welt-Epoche fuer regionale Simulation '${region.worldId}' fehlt.`);
      }
      const atMs = regionalSimulationMillisecond(epoch, at);
      if (atMs === undefined || atMs < region.nowMs) continue;

      const pending: TimedRegionalSimulationWork[] = [];
      for (const scheduled of scheduledCommands?.at(
        region.worldId,
        region.regionId,
        region.nowMs,
      ) ?? []) {
        pending.push({
          atMs: scheduled.atMs,
          command: { commandId: scheduled.commandId, command: scheduled.command },
        });
      }
      let cursorMs = region.nowMs;
      if (atMs > region.nowMs) {
        for (const scheduled of scheduledCommands?.due(
          region.worldId,
          region.regionId,
          region.nowMs,
          atMs,
        ) ?? []) {
          if (scheduled.atMs > cursorMs) {
            pending.push({
              atMs: scheduled.atMs,
              command: {
                commandId: `advance-to-ms:${scheduled.atMs}`,
                command: { type: "advance-to", atMs: scheduled.atMs },
              },
            });
            cursorMs = scheduled.atMs;
          }
          pending.push({
            atMs: scheduled.atMs,
            command: { commandId: scheduled.commandId, command: scheduled.command },
          });
        }
        if (cursorMs < atMs) {
          pending.push({
            atMs,
            command: {
              commandId: `advance-to-ms:${atMs}`,
              command: { type: "advance-to", atMs },
            },
          });
        }
      }
      for (const chunk of chunkWithoutSplittingBoundary(pending)) {
        await worker.applyBatch({
          worldId: region.worldId,
          regionId: region.regionId,
          commands: chunk.map((item) => item.command),
        }, at);
      }
      if (atMs > region.nowMs) advanced += 1;
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
