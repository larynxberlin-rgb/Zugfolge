import { fleetWorldCheckpoints, worlds } from "@zugfolge/db";
import type {
  FleetCommandResult,
  FleetCommandReceipt,
  FleetRuntime,
  FleetWorldInitialized,
  FleetWorldInitialization,
  NativeFleetCommand,
  NativeFleetWorldState,
} from "@zugfolge/runtime-native";
import {
  FLEET_COMMAND_RECEIPT_SCHEMA,
  canonicalFleetCommandHash,
  canonicalFleetCommandJson,
  canonicalizeFleetCommand,
  canonicalizeFleetCommandForState,
  fleetCommandEntity,
} from "@zugfolge/runtime-native";
import { and, desc, eq, sql } from "drizzle-orm";

import {
  canonicalFleetJson,
  loadFleetMobilizationSnapshot,
  persistFleetMobilizationSnapshot,
  validateFleetMobilizationEnvelope,
  type FleetMobilizationEnvelope,
  type FleetMobilizationSnapshot,
} from "./fleet-snapshot.js";
import type { EconomyDatabase } from "./ledger.js";

export interface FleetProducerCheckpoint {
  readonly state: NativeFleetWorldState;
  readonly stateHash: string;
  readonly snapshot: FleetMobilizationSnapshot;
  readonly snapshotHash: string;
  readonly commandId: string | null;
  readonly commandSchema: string | null;
  readonly commandJson: string | null;
  readonly commandHash: string | null;
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
  readonly command: NativeFleetCommand;
}

/** Stabile 409-Grenze fuer konkurrierende oder abweichende Producer-Aufrufe. */
export class FleetProducerConflictError extends Error {
  override readonly name = "FleetProducerConflictError";
}

/** Persistenz- oder Native-Inkonsistenz, bei der fail-closed kein Write erfolgt. */
export class FleetProducerUnavailableError extends Error {
  override readonly name = "FleetProducerUnavailableError";
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FleetProducerUnavailableError(message);
}

function conflictInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FleetProducerConflictError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCheckpointState(
  value: unknown,
  expectedWorldId: string,
  expectedRevision: number,
  expectedStateHash: string,
): NativeFleetWorldState {
  invariant(isRecord(value), "Persistierter M5-Zustand ist kein Objekt.");
  invariant(value["schemaVersion"] === "zugfolge-fleet-world-state/v2", "Persistierter M5-Zustand hat ein unbekanntes Schema.");
  invariant(value["worldId"] === expectedWorldId, "Persistierter M5-Zustand verletzt Weltisolation.");
  invariant(value["revision"] === expectedRevision, "Persistierter M5-Zustand besitzt eine fremde Revision.");
  invariant(Number.isSafeInteger(value["producedAt"]) && (value["producedAt"] as number) >= 0, "Persistierter M5-Zustand hat keine gueltige Zustandszeit.");
  invariant(isRecord(value["formations"]), "Persistierter M5-Zustand besitzt keine Formationen.");
  invariant(isRecord(value["personnelDuties"]), "Persistierter M5-Zustand besitzt keine Personaldienste.");
  invariant(isRecord(value["pathReservations"]), "Persistierter M5-Zustand besitzt keine Trassenreservierungen.");
  invariant(typeof value["authorityReleaseHash"] === "string" && /^[a-f0-9]{64}$/.test(value["authorityReleaseHash"]), "Persistierter M5-Zustand besitzt keinen Authority-Release-Hash.");
  invariant(isRecord(value["authorityRelease"]), "Persistierter M5-Zustand besitzt keinen Authority-Release.");
  invariant(/^[a-f0-9]{64}$/.test(expectedStateHash), "Persistierter M5-Zustandshash ist kein SHA-256.");
  return value as NativeFleetWorldState;
}

async function latestCheckpoint(
  db: EconomyDatabase,
  worldId: string,
): Promise<FleetProducerCheckpoint | undefined> {
  const [row] = await db
    .select()
    .from(fleetWorldCheckpoints)
    .where(eq(fleetWorldCheckpoints.worldId, worldId))
    .orderBy(desc(fleetWorldCheckpoints.revision))
    .limit(1);
  if (row === undefined) return undefined;
  return decodeCheckpointRow(db, row);
}

interface FleetCheckpointRow {
  readonly worldId: string;
  readonly revision: number;
  readonly stateSchema: string;
  readonly state: unknown;
  readonly stateHash: string;
  readonly snapshotHash: string;
  readonly commandId: string | null;
  readonly commandSchema: string | null;
  readonly commandJson: string | null;
  readonly commandHash: string | null;
}

async function decodeCheckpointRow(
  db: EconomyDatabase,
  row: FleetCheckpointRow,
): Promise<FleetProducerCheckpoint> {
  const state = decodeCheckpointState(row.state, row.worldId, row.revision, row.stateHash);
  invariant(state.schemaVersion === row.stateSchema, "Persistierter M5-Zustand und Schemazeiger widersprechen sich.");
  const snapshot = await loadFleetMobilizationSnapshot(db, row.worldId, {
    fleetRevision: row.revision,
    snapshotHash: row.snapshotHash,
  });
  invariant(snapshot.producedAt === state.producedAt, "Persistierter M5-Zustand und Snapshot haben verschiedene Zustandszeiten.");
  return {
    state,
    stateHash: row.stateHash,
    snapshot,
    snapshotHash: row.snapshotHash,
    commandId: row.commandId,
    commandSchema: row.commandSchema,
    commandJson: row.commandJson,
    commandHash: row.commandHash,
  };
}

async function checkpointAtRevision(
  db: EconomyDatabase,
  worldId: string,
  revision: number,
): Promise<FleetProducerCheckpoint | undefined> {
  const [row] = await db
    .select()
    .from(fleetWorldCheckpoints)
    .where(and(
      eq(fleetWorldCheckpoints.worldId, worldId),
      eq(fleetWorldCheckpoints.revision, revision),
    ))
    .limit(1);
  return row === undefined ? undefined : decodeCheckpointRow(db, row);
}

/** Loads the last fully committed Rust checkpoint after a process restart. */
export function loadFleetProducerCheckpoint(
  db: EconomyDatabase,
  worldId: string,
): Promise<FleetProducerCheckpoint | undefined> {
  return latestCheckpoint(db, worldId);
}

/** Loads the exact canonical command for an authenticated idempotent retry. */
export async function loadFleetProducerCommand(
  db: EconomyDatabase,
  worldId: string,
  commandId: string,
): Promise<NativeFleetCommand | undefined> {
  const [row] = await db.select({ commandJson: fleetWorldCheckpoints.commandJson })
    .from(fleetWorldCheckpoints)
    .where(and(eq(fleetWorldCheckpoints.worldId, worldId), eq(fleetWorldCheckpoints.commandId, commandId)))
    .limit(1);
  if (row?.commandJson === null || row?.commandJson === undefined) return undefined;
  const parsed = canonicalizeFleetCommand(JSON.parse(row.commandJson) as NativeFleetCommand);
  invariant(parsed.worldId === worldId && parsed.commandId === commandId, "Persistiertes M5-Kommando verletzt Welt- oder Idempotenzbindung.");
  return parsed;
}

function exactCommand(state: NativeFleetWorldState, command: NativeFleetCommand): {
  readonly command: NativeFleetCommand;
  readonly json: string;
} {
  const canonical = canonicalizeFleetCommandForState(state, command);
  return { command: canonical, json: canonicalFleetCommandJson(canonical) };
}

function runtimeEnvelope(
  output: Pick<FleetWorldInitialized, "snapshot" | "snapshotHash">,
): FleetMobilizationEnvelope {
  return { snapshot: output.snapshot, snapshotHash: output.snapshotHash };
}

async function lockWorld(db: EconomyDatabase, worldId: string): Promise<void> {
  await db.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${worldId} for update`);
}

/**
 * Creates revision zero and its M6 projection in one world-locked commit.
 * An exact retry while revision zero is still current performs no write.
 */
export async function initializeFleetProducer(
  input: InitializeFleetProducerInput,
): Promise<FleetWorldInitialized> {
  return input.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as EconomyDatabase;
    await lockWorld(tx, input.initialization.worldId);
    const existing = await latestCheckpoint(tx, input.initialization.worldId);
    const initialized = input.runtime.initializeFleet(input.initialization);
    if (existing !== undefined) {
      conflictInvariant(existing.state.revision === 0, "M5-Flottenwelt wurde bereits ueber Revision 0 hinaus fortgeschrieben.");
      conflictInvariant(existing.stateHash === initialized.stateHash, "Wiederholte M5-Initialisierung erzeugte einen anderen Zustandshash.");
      conflictInvariant(canonicalFleetJson(existing.state) === canonicalFleetJson(initialized.state), "Wiederholte M5-Initialisierung erzeugte einen anderen Zustand.");
      conflictInvariant(existing.snapshotHash === initialized.snapshotHash, "Wiederholte M5-Initialisierung erzeugte einen anderen Snapshothash.");
      conflictInvariant(canonicalFleetJson(existing.snapshot) === canonicalFleetJson(initialized.snapshot), "Wiederholte M5-Initialisierung erzeugte andere Nutzdaten.");
      return initialized;
    }

    await tx.insert(fleetWorldCheckpoints).values({
      worldId: input.initialization.worldId,
      revision: initialized.state.revision,
      stateSchema: initialized.state.schemaVersion,
      state: initialized.state,
      stateHash: initialized.stateHash,
      snapshotHash: initialized.snapshotHash,
      commandId: null,
      commandSchema: null,
      commandJson: null,
      commandHash: null,
      producedAt: new Date(initialized.state.producedAt * 1_000),
      ingestedAt: input.ingestedAt,
    });
    await persistFleetMobilizationSnapshot(
      tx,
      input.initialization.worldId,
      runtimeEnvelope(initialized),
      input.ingestedAt,
    );
    return initialized;
  });
}

/**
 * Locks the world, restores the last committed Rust state, applies one exact
 * versioned command, and atomically appends checkpoint plus M6 projection.
 * The caller cannot inject state or snapshot JSON.
 *
 * An idempotent retry returns the exact historical result of that command,
 * even if newer revisions exist. Callers that want to continue writing must
 * load the latest checkpoint instead of treating a replay result as the head.
 */
export async function applyFleetProducerCommand(
  input: ApplyFleetProducerCommandInput,
): Promise<FleetCommandResult> {
  return input.db.transaction(async (rawTx) => applyFleetProducerCommandInTransaction({
    ...input,
    db: rawTx as unknown as EconomyDatabase,
  }));
}

/**
 * Variante fuer einen bereits geoeffneten fachlichen Commit. Sie wird vom
 * Sekundaermarkt genutzt, damit Rust-Checkpoint, Eigentumswechsel, Ledger,
 * Eventlog und Postfach entweder gemeinsam sichtbar werden oder gemeinsam
 * zurueckrollen. Der Welt-Lock bleibt auch hier zwingend.
 */
export async function applyFleetProducerCommandInTransaction(
  input: ApplyFleetProducerCommandInput,
): Promise<FleetCommandResult> {
  const submitted = canonicalizeFleetCommand(input.command);
  const tx = input.db;
  await lockWorld(tx, submitted.worldId);
  const current = await latestCheckpoint(tx, submitted.worldId);
  conflictInvariant(current !== undefined, "M5-Flottenwelt wurde noch nicht initialisiert.");
  const exact = exactCommand(current.state, submitted);
  const exactCommandHash = canonicalFleetCommandHash(exact.command);

  const [priorCommand] = await tx
      .select({
        revision: fleetWorldCheckpoints.revision,
        stateHash: fleetWorldCheckpoints.stateHash,
        snapshotHash: fleetWorldCheckpoints.snapshotHash,
        commandSchema: fleetWorldCheckpoints.commandSchema,
        commandJson: fleetWorldCheckpoints.commandJson,
        commandHash: fleetWorldCheckpoints.commandHash,
      })
      .from(fleetWorldCheckpoints)
      .where(and(
        eq(fleetWorldCheckpoints.worldId, exact.command.worldId),
        eq(fleetWorldCheckpoints.commandId, exact.command.commandId),
      ))
      .limit(1);
    const entity = fleetCommandEntity(exact.command);
    let replayCheckpoint: FleetProducerCheckpoint | undefined;
    let replayReceipt: FleetCommandReceipt | undefined;
    if (priorCommand !== undefined) {
      conflictInvariant(priorCommand.commandSchema === exact.command.schemaVersion, "Replay verwendet ein anderes M5-Kommandoschema.");
      conflictInvariant(priorCommand.commandJson === exact.json, "Replay verwendet nicht das kanonisch persistierte M5-Kommando.");
      invariant(priorCommand.commandHash === exactCommandHash, "Replay-Kommando und persistierter Rust-Hash widersprechen sich.");
      replayCheckpoint = await checkpointAtRevision(tx, exact.command.worldId, priorCommand.revision);
      invariant(replayCheckpoint !== undefined, "Persistierte M5-Receipt verweist auf keinen historischen Checkpoint.");
      invariant(replayCheckpoint.commandId === exact.command.commandId, "Historischer M5-Checkpoint gehoert zu einem anderen Kommando.");
      invariant(replayCheckpoint.commandSchema === priorCommand.commandSchema, "Historischer M5-Checkpoint besitzt ein anderes Kommandoschema.");
      invariant(replayCheckpoint.commandJson === priorCommand.commandJson, "Historischer M5-Checkpoint besitzt eine andere Kanonform.");
      invariant(replayCheckpoint.commandHash === priorCommand.commandHash, "Historischer M5-Checkpoint besitzt einen anderen Kommandohash.");
      invariant(replayCheckpoint.stateHash === priorCommand.stateHash, "Historischer M5-Checkpoint besitzt einen anderen Zustandshash.");
      invariant(replayCheckpoint.snapshotHash === priorCommand.snapshotHash, "Historischer M5-Checkpoint besitzt einen anderen Snapshothash.");
      replayReceipt = {
        schemaVersion: FLEET_COMMAND_RECEIPT_SCHEMA,
        worldId: exact.command.worldId,
        commandId: exact.command.commandId,
        commandHash: priorCommand.commandHash,
        canonicalCommandJson: priorCommand.commandJson,
        resultingRevision: priorCommand.revision,
        entityKind: entity.entityKind,
        entityId: entity.entityId,
        resultingStateHash: priorCommand.stateHash,
        resultingSnapshotHash: priorCommand.snapshotHash,
      };
    }
    const result = input.runtime.applyFleetCommand(
      replayCheckpoint?.state ?? current.state,
      exact.command,
      replayReceipt,
    );

    if (result.idempotentReplay) {
      invariant(priorCommand !== undefined, "Rust meldet Replay ohne persistiertes Ursprungskommando.");
      invariant(replayCheckpoint !== undefined, "Rust meldet Replay ohne historischen M5-Checkpoint.");
      invariant(priorCommand.commandHash === result.commandReceipt.commandHash, "Replay und persistiertes M5-Kommando haben verschiedene Rust-Hashes.");
      invariant(result.commandReceipt.commandHash === exactCommandHash, "Replay-Receipt und kanonisches M5-Kommando haben verschiedene sprachuebergreifende Hashes.");
      invariant(priorCommand.commandJson === result.commandReceipt.canonicalCommandJson, "Replay und Rust-Quittung binden verschiedene kanonische Kommandos.");
      invariant(priorCommand.revision === result.commandReceipt.resultingRevision, "Replay und Rust-Quittung binden verschiedene Revisionen.");
      invariant(priorCommand.stateHash === result.commandReceipt.resultingStateHash, "Replay und Rust-Quittung binden verschiedene historische Zustandshashes.");
      invariant(priorCommand.snapshotHash === result.commandReceipt.resultingSnapshotHash, "Replay und Rust-Quittung binden verschiedene historische Snapshothashes.");
      invariant(result.stateHash === replayCheckpoint.stateHash, "Replay veraenderte den historischen M5-Zustandshash.");
      invariant(result.snapshotHash === replayCheckpoint.snapshotHash, "Replay veraenderte den historischen M5-Snapshothash.");
      invariant(canonicalFleetJson(result.state) === canonicalFleetJson(replayCheckpoint.state), "Replay vermischte aktuellen und historischen M5-Zustand.");
      validateFleetMobilizationEnvelope(runtimeEnvelope(result));
      invariant(canonicalFleetJson(result.snapshot) === canonicalFleetJson(replayCheckpoint.snapshot), "Replay veraenderte den historischen M5-Snapshot.");
      return result;
    }

    invariant(priorCommand === undefined, "Neue Rust-Anwendung kollidiert mit einem persistierten M5-Kommando.");
    invariant(result.commandReceipt.commandId === exact.command.commandId, "Rust-M5-Receipt gehoert zu einem anderen Kommando.");
    invariant(result.commandReceipt.commandHash === exactCommandHash, "Rust-M5-Receipt und kanonisches M5-Kommando haben verschiedene sprachuebergreifende Hashes.");
    invariant(result.commandReceipt.canonicalCommandJson === exact.json, "Rust-M5-Receipt bindet nicht das kanonisch persistierte Kommando.");
    invariant(result.commandReceipt.resultingStateHash === result.stateHash, "Rust-M5-Receipt bindet einen anderen Zustandshash.");
    invariant(result.commandReceipt.resultingSnapshotHash === result.snapshotHash, "Rust-M5-Receipt bindet einen anderen Snapshothash.");
    invariant(result.commandReceipt.resultingRevision === result.state.revision, "Rust-M5-Receipt bindet eine andere Revision.");
    invariant(result.state.revision === current.state.revision + 1, "Rust-M5-Zustand uebersprang eine persistierte Revision.");
    invariant(result.stateHash !== current.stateHash, "Rust-M5-Anwendung veraenderte den Zustandshash nicht.");
    await tx.insert(fleetWorldCheckpoints).values({
      worldId: exact.command.worldId,
      revision: result.state.revision,
      stateSchema: result.state.schemaVersion,
      state: result.state,
      stateHash: result.stateHash,
      snapshotHash: result.snapshotHash,
      commandId: exact.command.commandId,
      commandSchema: exact.command.schemaVersion,
      commandJson: result.commandReceipt.canonicalCommandJson,
      commandHash: result.commandReceipt.commandHash,
      producedAt: new Date(result.state.producedAt * 1_000),
      ingestedAt: input.ingestedAt,
    });
    await persistFleetMobilizationSnapshot(
      tx,
      exact.command.worldId,
      runtimeEnvelope(result),
      input.ingestedAt,
    );
    return result;
}
