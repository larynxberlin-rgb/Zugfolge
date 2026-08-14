import { describe, expect, it } from "vitest";

import type { OperationsDecision } from "./projection.js";
import { OperationsRegistry } from "./stream.js";

const decision = {
  decisionId: "decision-1",
  kind: "disruption",
} as unknown as OperationsDecision;

describe("OperationsRegistry", () => {
  it("released nur die Streams einer Tutorialwelt idempotent", () => {
    const registry = new OperationsRegistry(3, 2);
    const publicFeed = registry.forOperator("public", "operator-public");
    publicFeed.publish({ worldId: "public", operatorId: "operator-public", sequence: 1, decision });
    registry.forOperator("tutorial", "operator-a");
    registry.forOperator("tutorial", "operator-b");
    expect(registry.size).toBe(3);

    registry.releaseWorld("tutorial");
    registry.releaseWorld("tutorial");

    expect(registry.size).toBe(1);
    expect(registry.forOperator("public", "operator-public")).toBe(publicFeed);
    expect(publicFeed.eventsAfter(0)).toHaveLength(1);
    expect(registry.forOperator("tutorial", "operator-a").eventsAfter(0)).toEqual([]);
  });
});
