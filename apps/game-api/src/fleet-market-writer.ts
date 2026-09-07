import type {
  CooperationDatabase,
  FleetAssetTransferIntent,
  FleetAssetTransferWriter,
} from "@zugfolge/cooperation";
import { CooperationConflictError } from "@zugfolge/cooperation";
import {
  applyFleetProducerCommandInTransaction,
  loadFleetProducerCheckpoint,
  type EconomyDatabase,
} from "@zugfolge/economy";
import {
  FLEET_ASSET_TRANSFER_COMMAND_SCHEMA,
  type FleetRuntime,
} from "@zugfolge/runtime-native";

/**
 * Bindet den M12-Markt an denselben Rust-Single-Writer wie Formationen,
 * Personal und Trassen. Der Aufrufer besitzt bereits den Welt-DB-Commit.
 */
export class GameFleetAssetTransferWriter implements FleetAssetTransferWriter {
  constructor(private readonly runtime: FleetRuntime) {}

  async apply(tx: CooperationDatabase, intent: FleetAssetTransferIntent) {
    const db = tx as unknown as EconomyDatabase;
    const checkpoint = await loadFleetProducerCheckpoint(db, intent.worldId);
    if (checkpoint === undefined) {
      throw new CooperationConflictError("M5-Flottenwelt wurde vor der Marktübertragung nicht initialisiert.", "fleet_single_writer_unavailable");
    }
    const result = await applyFleetProducerCommandInTransaction({
      db,
      runtime: this.runtime,
      command: {
        schemaVersion: FLEET_ASSET_TRANSFER_COMMAND_SCHEMA,
        worldId: intent.worldId,
        commandId: intent.commandId,
        expectedStateHash: checkpoint.stateHash,
        expectedRevision: checkpoint.state.revision,
        atS: intent.atS,
        vehicleId: intent.vehicleId,
        transferType: intent.transferType,
        fromOwnerOperatorId: intent.fromOwnerOperatorId,
        toOwnerOperatorId: intent.toOwnerOperatorId,
        fromHolderOperatorId: intent.fromHolderOperatorId,
        toHolderOperatorId: intent.toHolderOperatorId,
        lessorOperatorId: intent.lessorOperatorId,
        contractId: intent.contractId,
        validUntilS: intent.validUntilS,
        transferReceiptHash: intent.transferReceiptHash,
      },
      ingestedAt: new Date(),
      projectMarketAssets: false,
    }).catch((error: unknown) => {
      if (error instanceof CooperationConflictError) throw error;
      throw new CooperationConflictError("Die autoritative Flotte hat die Übergabe noch nicht freigegeben. Fahrzeug- und Vertragsbindungen müssen zuerst geklärt werden.", "fleet_transfer_blocked");
    });
    return {
      resultingStateHash: result.stateHash,
      resultingRevision: result.state.revision,
    };
  }
}
