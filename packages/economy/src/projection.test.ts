import { describe, expect, it } from "vitest";

import { economyStateForPlayer } from "./projection.js";
import type { EconomyWorldState } from "./workflow.js";

const competitorBid = Object.freeze({
  id: "bid-competitor", operatorId: "operator-competitor", orderingFeeCentsPerTrainKm: 1_001n,
  vehicle: { formationId: "formation-competitor" }, promises: { extraSeats: 20, punctualityBasisPoints: 9_700, additionalStops: 1 }, submittedAt: 100,
});
const ownBid = Object.freeze({ ...competitorBid, id: "bid-own", operatorId: "operator-own", orderingFeeCentsPerTrainKm: 1_100n });

function state(phase: "open" | "awarded"): EconomyWorldState {
  const tender = { id: "tender-1", worldId: "world-1" };
  const lifecycle = phase === "open"
    ? { phase, tender, bids: [competitorBid, ownBid] }
    : { phase, tender, bids: [competitorBid, ownBid], winningBid: competitorBid };
  return {
    worldId: "world-1", profile: {}, releasePin: {}, lots: [], calendar: [], tenders: new Map([["tender-1", lifecycle]]),
    contracts: new Map(), mobilizations: new Map(), publicOperations: new Map(), revision: 4,
    tenderAutomation: new Map(), budgets: new Map(), prequalifications: new Map(), insolventOperators: new Set(),
    operatorRestrictions: new Map(), settledPeriods: new Set(), processedCommands: new Set(), operatingRuntimeByLot: new Map(),
  } as unknown as EconomyWorldState;
}

describe("player-facing economy projection", () => {
  it("reveals only the player's own bid while a tender is open", () => {
    const projected = economyStateForPlayer(state("open"), new Set(["operator-own"])) as { tenders: Map<string, Record<string, unknown>> };
    expect(projected.tenders.get("tender-1")).toMatchObject({ bidCount: 2, ownBids: [{ id: "bid-own", orderingFeeCentsPerTrainKm: 1_100n }] });
    expect(projected.tenders.get("tender-1")).not.toHaveProperty("bids");
    expect(JSON.stringify([...projected.tenders], (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("bid-competitor");
  });

  it("publishes the winner identity after award without losing bid details", () => {
    const projected = economyStateForPlayer(state("awarded"), new Set()) as { tenders: Map<string, Record<string, unknown>> };
    expect(projected.tenders.get("tender-1")).toMatchObject({ bidCount: 2, winningOperatorId: "operator-competitor" });
    expect(projected.tenders.get("tender-1")).not.toHaveProperty("ownBids");
    expect(projected.tenders.get("tender-1")).not.toHaveProperty("winningBid");
  });
});
