import type { EconomyWorldState, TenderLifecycle } from "./workflow.js";

type PublicTenderLifecycle = Omit<TenderLifecycle, "bids" | "winningBid"> & {
  readonly bidCount: number;
  readonly ownBids?: TenderLifecycle["bids"];
  readonly winningOperatorId?: string;
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
    const ownBids = Object.freeze(lifecycle.bids.filter((bid) => operatorIds.has(bid.operatorId)));
    if (lifecycle.phase === "awarded") {
      tenders.set(tenderId, Object.freeze({
        phase: lifecycle.phase,
        tender: lifecycle.tender,
        bidCount: lifecycle.bids.length,
        ...(ownBids.length === 0 ? {} : { ownBids }),
        winningOperatorId: lifecycle.winningBid.operatorId,
      }));
    } else if (lifecycle.phase === "failed") {
      tenders.set(tenderId, Object.freeze({
        phase: lifecycle.phase,
        tender: lifecycle.tender,
        publicOperation: lifecycle.publicOperation,
        bidCount: lifecycle.bids.length,
        ...(ownBids.length === 0 ? {} : { ownBids }),
      }));
    } else {
      tenders.set(tenderId, Object.freeze({
        phase: lifecycle.phase,
        tender: lifecycle.tender,
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
    mobilizations: state.mobilizations,
    publicOperations: state.publicOperations,
    revision: state.revision,
  });
}
