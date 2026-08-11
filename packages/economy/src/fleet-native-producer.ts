import type {
  FleetCommandResult,
  FleetRuntime,
  FleetWorldInitialized,
  FleetWorldInitialization,
  NativeFleetCommand,
  NativeFleetWorldState,
} from "@zugfolge/runtime-native";

import {
  persistFleetMobilizationSnapshot,
  type FleetMobilizationEnvelope,
} from "./fleet-snapshot.js";
import type { EconomyDatabase } from "./ledger.js";

export interface FleetProducerCursor {
  readonly state: NativeFleetWorldState;
  readonly stateHash: string;
}

interface FleetProducerPersistence {
  readonly db: EconomyDatabase;
  readonly runtime: FleetRuntime;
  readonly ingestedAt: Date;
}

export interface InitializeFleetProducerInput extends FleetProducerPersistence {
  readonly initialization: FleetWorldInitialization;
}

export interface ApplyFleetProducerCommandInput extends FleetProducerPersistence {
  readonly current: FleetProducerCursor;
  readonly command: NativeFleetCommand;
}

async function persistRuntimeSnapshot(
  db: EconomyDatabase,
  expectedWorldId: string,
  output: Pick<FleetWorldInitialized, "snapshot" | "snapshotHash">,
  ingestedAt: Date,
): Promise<void> {
  // Do not rebuild or rehash this envelope here. The append-only boundary
  // validates the exact Rust payload/hash pair before it writes either value.
  const envelope: FleetMobilizationEnvelope = {
    snapshot: output.snapshot,
    snapshotHash: output.snapshotHash,
  };
  await persistFleetMobilizationSnapshot(db, expectedWorldId, envelope, ingestedAt);
}

/**
 * Starts the Rust M5 single writer and persists its empty revision-zero
 * projection. There is deliberately no snapshot parameter on this API.
 */
export async function initializeFleetProducer(
  input: InitializeFleetProducerInput,
): Promise<FleetWorldInitialized> {
  const initialized = input.runtime.initializeFleet(input.initialization);
  await persistRuntimeSnapshot(
    input.db,
    input.initialization.worldId,
    initialized,
    input.ingestedAt,
  );
  return initialized;
}

/**
 * Sends exactly one versioned domain command to Rust and persists only the
 * snapshot/hash returned with the resulting authoritative state.
 *
 * Callers must durably retain `result.state`, `result.stateHash`, and the exact
 * command together so a retry can replay the same command ID and payload.
 */
export async function applyFleetProducerCommand(
  input: ApplyFleetProducerCommandInput,
): Promise<FleetCommandResult> {
  const result = input.runtime.applyFleetCommand(input.current.state, input.command);
  await persistRuntimeSnapshot(input.db, input.command.worldId, result, input.ingestedAt);
  return result;
}
