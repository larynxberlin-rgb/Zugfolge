import type { EconomyWorldState, TenderLifecycle, Mobilization } from "./workflow.js";
import type { GtfsServicePattern } from "@zugfolge/gtfs";

export type PublicMobilization = Pick<Mobilization, "tenderId" | "winnerOperatorId" | "deadline" | "completed">;

type PublicTenderLifecycle = Omit<TenderLifecycle, "bids" | "winningBid"> & {
  readonly bidCount: number;
  readonly ownBids?: TenderLifecycle["bids"];
  readonly winningOperatorId?: string;
  readonly serviceLines: readonly NonNullable<GtfsServicePattern["presentation"]>[];
};

/**
 * Player-facing economy state. Open bids are sealed: competitors learn only
 * the aggregate count, while the submitting operator can still review its own
 * offer. After award, the winner identity is public, but losing prices and
 * quality promises remain confidential.
 */
export function economyStateForPlayer(state: EconomyWorldState, operatorIds: ReadonlySet<string>): unknown {
  const tenders = new Map<string, PublicTenderLifecycle>();
  for (const [tenderId, lifecycle] of state.tenders) {
    const lines = new Set(lifecycle.tender.specification.lines);
    const serviceLines = [...new Map((state.planning?.snapshot.patterns ?? [])
      .filter((pattern) => lines.has(pattern.lineId) && pattern.presentation !== undefined)
      .map((pattern) => [JSON.stringify(pattern.presentation), pattern.presentation!])).values()];
    const ownBids = Object.freeze(lifecycle.bids.filter((bid) => operatorIds.has(bid.operatorId)));
    if (lifecycle.phase === "awarded") {
      tenders.set(tenderId, Object.freeze({
        phase: lifecycle.phase,
        tender: lifecycle.tender,
        serviceLines,
        bidCount: lifecycle.bids.length,
        ...(ownBids.length === 0 ? {} : { ownBids }),
        winningOperatorId: lifecycle.winningBid.operatorId,
      }));
    } else if (lifecycle.phase === "failed") {
      tenders.set(tenderId, Object.freeze({
        phase: lifecycle.phase,
        tender: lifecycle.tender,
        serviceLines,
        publicOperation: lifecycle.publicOperation,
        bidCount: lifecycle.bids.length,
        ...(ownBids.length === 0 ? {} : { ownBids }),
      }));
    } else {
      tenders.set(tenderId, Object.freeze({
        phase: lifecycle.phase,
        tender: lifecycle.tender,
        serviceLines,
        bidCount: lifecycle.bids.length,
        ...(ownBids.length === 0 ? {} : { ownBids }),
      }));
    }
  }

  // Internal automation, all prequalification records, replay keys and raw
  // Rust states are server-owned. They are not a player projection.
  return Object.freeze({
    worldId: state.worldId,
    profile: state.profile,
    releasePin: state.releasePin,
    lots: state.lots,
    calendar: state.calendar,
    tenders,
    contracts: state.contracts,
    mobilizations: new Map([...state.mobilizations].map(([id, mobilization]) => [id,
      operatorIds.has(mobilization.winnerOperatorId) ? mobilization : Object.freeze({
        tenderId: mobilization.tenderId, winnerOperatorId: mobilization.winnerOperatorId,
        deadline: mobilization.deadline, completed: mobilization.completed,
      } satisfies PublicMobilization),
    ])),
    publicOperations: state.publicOperations,
    revision: state.revision,
  });
}
