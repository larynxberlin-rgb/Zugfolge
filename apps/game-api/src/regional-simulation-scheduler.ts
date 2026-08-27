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

export interface OperationalScheduledCommandBoundary {
  readonly atMs: number;
  readonly commands: readonly OperationalScheduledCommand[];
}

export interface RegionalScheduledCommandCatalog {
  at(worldId: string, regionId: string, atMs: number): readonly OperationalScheduledCommand[];
  /**
   * Speicherbegrenzte Grenze fuer Catch-ups. Jede gelieferte Zeitgrenze muss
   * vollstaendig, nicht leer und streng aufsteigend sein.
   */
  dueBoundaries(
    worldId: string,
    regionId: string,
    afterMs: number,
    throughMs: number,
  ): Iterable<OperationalScheduledCommandBoundary>;
}

type RegionalSimulationAdvancer = Pick<
  RegionalSimulationWorker,
  "applyBatch" | "readyRegions" | "recover"
>;

export const REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT = 256;
export const REGIONAL_SIMULATION_BATCH_SPAN_MS = 60 * 1_000;
export const REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT =
  REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT;

export interface TimedRegionalSimulationWork {
  readonly atMs: number;
  readonly command: RegionalSimulationWorkBatch["commands"][number];
}

export interface RegionalRealtimeRegistration {
  readonly worldId: string;
  readonly regionId: string;
  /** Aus dem signierten Deployment kanonisch abgeleitete Restore-Bindung. */
  readonly initializationHash: string;
}

export type RegionalSimulationSchedulerPhase =
  | "region-started"
  | "recovery-started"
  | "recovery-completed"
  | "batch-started"
  | "batch-completed"
  | "region-idle"
  | "region-completed"
  | "region-failed";

/** Interner Diagnosefortschritt; wird nie Bestandteil oeffentlicher Healthdetails. */
export interface RegionalSimulationSchedulerProgress {
  readonly phase: RegionalSimulationSchedulerPhase;
  readonly worldId: string;
  readonly regionId: string;
  readonly currentNowMs?: number;
  readonly targetNowMs?: number;
  readonly commandCount?: number;
}

export type RegionalSimulationSchedulerProgressObserver = (
  progress: RegionalSimulationSchedulerProgress,
) => void;

function reportProgress(
  observer: RegionalSimulationSchedulerProgressObserver | undefined,
  progress: RegionalSimulationSchedulerProgress,
): void {
  if (observer === undefined) return;
  try {
    observer(progress);
  } catch {
    // Diagnoseausgabe darf den autoritativen Takt niemals beeinflussen.
  }
}

function registrationKey(registration: RegionalRealtimeRegistration): string {
  return `${registration.worldId}\u0000${registration.regionId}`;
}

export function chunkWithoutSplittingBoundary(
  commands: readonly TimedRegionalSimulationWork[],
  targetSize = REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT,
): readonly (readonly TimedRegionalSimulationWork[])[] {
  if (
    !Number.isSafeInteger(targetSize)
    || targetSize <= 0
    || targetSize > REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT
  ) {
    throw new RangeError(
      `Scheduler-Batchgroesse muss zwischen 1 und ${REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT} liegen.`,
    );
  }
  const chunks: TimedRegionalSimulationWork[][] = [];
  let current: TimedRegionalSimulationWork[] = [];
  let index = 0;
  while (index < commands.length) {
    const atMs = commands[index]!.atMs;
    let groupEnd = index + 1;
    while (groupEnd < commands.length && commands[groupEnd]!.atMs === atMs) groupEnd += 1;
    const group = commands.slice(index, groupEnd);
    if (group.length > REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT) {
      throw new RangeError(
        `Scheduler-Zeitgrenze ${atMs} enthaelt mehr als ${REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT} atomare Kommandos.`,
      );
    }
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

function nextAbsoluteSimulationCheckpointMs(afterMs: number): number | undefined {
  const remainder = afterMs % REGIONAL_SIMULATION_BATCH_SPAN_MS;
  const delta = remainder === 0
    ? REGIONAL_SIMULATION_BATCH_SPAN_MS
    : REGIONAL_SIMULATION_BATCH_SPAN_MS - remainder;
  const checkpointMs = afterMs + delta;
  return Number.isSafeInteger(checkpointMs) ? checkpointMs : undefined;
}

function* dueScheduledCommandBoundaries(
  catalog: RegionalScheduledCommandCatalog,
  worldId: string,
  regionId: string,
  afterMs: number,
  throughMs: number,
): IterableIterator<OperationalScheduledCommandBoundary> {
  const boundaries = catalog.dueBoundaries(worldId, regionId, afterMs, throughMs);
  const iterator = boundaries[Symbol.iterator]();
  const validateBoundary = (
    boundary: OperationalScheduledCommandBoundary,
    previousAtMs: number,
  ): void => {
    if (
      !Number.isSafeInteger(boundary.atMs)
      || boundary.atMs <= previousAtMs
      || boundary.atMs > throughMs
      || boundary.commands.length === 0
      || boundary.commands.some((command) => command.atMs !== boundary.atMs)
      || boundary.commands.some((command) => command.command.type === "advance-to")
    ) {
      throw new Error(
        `Scheduler-Katalog lieferte eine unvollstaendige oder ungeordnete Zeitgrenze fuer '${worldId}/${regionId}'.`,
      );
    }
  };
  let current = iterator.next();
  if (current.done) return;
  validateBoundary(current.value, afterMs);
  while (true) {
    const next = iterator.next();
    if (!next.done) validateBoundary(next.value, current.value.atMs);
    yield current.value;
    if (next.done) return;
    current = next;
  }
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
  observeProgress?: RegionalSimulationSchedulerProgressObserver,
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
      reportProgress(observeProgress, {
        phase: "region-started",
        worldId: registration.worldId,
        regionId: registration.regionId,
      });
      const key = registrationKey(registration);
      const ready = readyByKey.get(key);
      let region = ready;
      if (region?.initializationHash !== registration.initializationHash) {
        reportProgress(observeProgress, {
          phase: "recovery-started",
          worldId: registration.worldId,
          regionId: registration.regionId,
        });
        region = await worker.recover(
          registration.worldId,
          registration.regionId,
          registration.initializationHash,
        );
        reportProgress(observeProgress, {
          phase: "recovery-completed",
          worldId: registration.worldId,
          regionId: registration.regionId,
          currentNowMs: region.nowMs,
        });
      }
      if (
        region === undefined
        || registrationKey(region) !== key
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
      if (atMs === undefined || atMs < region.nowMs) {
        reportProgress(observeProgress, {
          phase: "region-idle",
          worldId: region.worldId,
          regionId: region.regionId,
          currentNowMs: region.nowMs,
          ...(atMs === undefined ? {} : { targetNowMs: atMs }),
        });
        continue;
      }

      const startedNowMs = region.nowMs;
      let currentNowMs = region.nowMs;
      let pendingBatch: TimedRegionalSimulationWork[] = [];
      let commandCount = 0;
      const flushBatch = async (): Promise<void> => {
        if (pendingBatch.length === 0) return;
        const chunk = pendingBatch;
        pendingBatch = [];
        reportProgress(observeProgress, {
          phase: "batch-started",
          worldId: region.worldId,
          regionId: region.regionId,
          currentNowMs,
          targetNowMs: atMs,
          commandCount: chunk.length,
        });
        let expectedCompletedNowMs = currentNowMs;
        for (const item of chunk) {
          if (item.command.command.type === "advance-to") {
            expectedCompletedNowMs = item.command.command.atMs;
          }
        }
        const batch = await worker.applyBatch({
          worldId: region.worldId,
          regionId: region.regionId,
          commands: chunk.map((item) => item.command),
        }, at);
        const completedNowMs = batch.state.world.nowMs;
        if (
          !Number.isSafeInteger(completedNowMs)
          || completedNowMs !== expectedCompletedNowMs
        ) {
          throw new Error(
            `Regionaler Takt '${region.worldId}/${region.regionId}' erreichte die Zielweltzeit ${expectedCompletedNowMs} nicht exakt.`,
          );
        }
        currentNowMs = completedNowMs;
        reportProgress(observeProgress, {
          phase: "batch-completed",
          worldId: region.worldId,
          regionId: region.regionId,
          currentNowMs,
          targetNowMs: atMs,
          commandCount: chunk.length,
        });
      };
      const enqueueBoundary = async (
        boundary: readonly TimedRegionalSimulationWork[],
      ): Promise<void> => {
        if (boundary.length === 0) return;
        const boundaryAtMs = boundary[0]!.atMs;
        if (
          boundary.length > REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT
          || boundary.some((item) => item.atMs !== boundaryAtMs)
        ) {
          throw new RangeError(
            `Scheduler-Zeitgrenze ${boundaryAtMs} enthaelt mehr als ${REGIONAL_SIMULATION_BOUNDARY_COMMAND_LIMIT} atomare Kommandos.`,
          );
        }
        if (
          pendingBatch.length > 0
          && (
            pendingBatch.length + boundary.length > REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT
            || boundaryAtMs - currentNowMs > REGIONAL_SIMULATION_BATCH_SPAN_MS
          )
        ) {
          await flushBatch();
        }
        if (boundaryAtMs - currentNowMs > REGIONAL_SIMULATION_BATCH_SPAN_MS) {
          throw new RangeError(
            `Scheduler-Zeitgrenze ${boundaryAtMs} ueberschreitet das maximale Simulationsfenster.`,
          );
        }
        pendingBatch.push(...boundary);
        commandCount += boundary.length;
        if (pendingBatch.length >= REGIONAL_SIMULATION_BATCH_COMMAND_LIMIT) await flushBatch();
      };

      const atBoundary = scheduledCommands?.at(
        region.worldId,
        region.regionId,
        region.nowMs,
      ) ?? [];
      if (atBoundary.some((scheduled) =>
        scheduled.atMs !== region.nowMs
        || scheduled.command.type === "advance-to")) {
        throw new Error(
          `Scheduler-Katalog lieferte eine fremde aktuelle Zeitgrenze fuer '${region.worldId}/${region.regionId}'.`,
        );
      }
      await enqueueBoundary(atBoundary.map((scheduled) => ({
        atMs: scheduled.atMs,
        command: { commandId: scheduled.commandId, command: scheduled.command },
      })));
      await flushBatch();

      let cursorMs = region.nowMs;
      if (atMs > region.nowMs) {
        const dueIterator = (scheduledCommands === undefined
          ? [][Symbol.iterator]()
          : dueScheduledCommandBoundaries(
            scheduledCommands,
            region.worldId,
            region.regionId,
            region.nowMs,
            atMs,
          )[Symbol.iterator]());
        let due = dueIterator.next();
        let checkpointMs = nextAbsoluteSimulationCheckpointMs(region.nowMs);
        while (!due.done || (checkpointMs !== undefined && checkpointMs <= atMs)) {
          const boundaryAtMs = Math.min(
            due.done ? Number.POSITIVE_INFINITY : due.value.atMs,
            checkpointMs !== undefined && checkpointMs <= atMs
              ? checkpointMs
              : Number.POSITIVE_INFINITY,
          );
          if (!Number.isSafeInteger(boundaryAtMs)) break;
          const scheduledBoundary = !due.done && due.value.atMs === boundaryAtMs
            ? due.value
            : undefined;
          // Fortsetzungsketten muessen bereits vor dem Advance existieren:
          // genau dieses Advance kann einen verspaeteten Vorgaenger am selben
          // Millisekundenrand physisch abschliessen. Materialize/Dispatch
          // bleiben dagegen hinter dem Advance und damit exakt zeitgebunden.
          const queuedContinuations = (scheduledBoundary?.commands ?? []).filter(
            ({ command }) => command.type === "queue-movement-continuation",
          );
          const commandsAtBoundary = (scheduledBoundary?.commands ?? []).filter(
            ({ command }) => command.type !== "queue-movement-continuation",
          );
          const timedBoundary: TimedRegionalSimulationWork[] = [
            ...queuedContinuations.map((scheduled) => ({
              atMs: scheduled.atMs,
              command: { commandId: scheduled.commandId, command: scheduled.command },
            })), {
            atMs: boundaryAtMs,
            command: {
              commandId: `advance-to-ms:${boundaryAtMs}`,
              command: { type: "advance-to", atMs: boundaryAtMs },
            },
          }, ...commandsAtBoundary.map((scheduled) => ({
            atMs: scheduled.atMs,
            command: { commandId: scheduled.commandId, command: scheduled.command },
          }))];
          await enqueueBoundary(timedBoundary);
          cursorMs = boundaryAtMs;
          if (scheduledBoundary !== undefined) due = dueIterator.next();
          if (checkpointMs === boundaryAtMs) {
            checkpointMs = nextAbsoluteSimulationCheckpointMs(checkpointMs);
          }
        }
        if (cursorMs < atMs) {
          await enqueueBoundary([{
            atMs,
            command: {
              commandId: `advance-to-ms:${atMs}`,
              command: { type: "advance-to", atMs },
            },
          }]);
        }
      }
      await flushBatch();
      if (currentNowMs !== atMs) {
        throw new Error(
          `Regionaler Takt '${region.worldId}/${region.regionId}' erreichte die Zielweltzeit ${atMs} nicht exakt.`,
        );
      }
      if (atMs > startedNowMs) advanced += 1;
      reportProgress(observeProgress, {
        phase: "region-completed",
        worldId: region.worldId,
        regionId: region.regionId,
        currentNowMs,
        targetNowMs: atMs,
        commandCount,
      });
    } catch (error) {
      reportProgress(observeProgress, {
        phase: "region-failed",
        worldId: registration.worldId,
        regionId: registration.regionId,
      });
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
