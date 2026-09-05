import { describe, expect, it } from "vitest";

import type { OperationsDecision } from "./projection.js";
import { OperationsRegistry } from "./stream.js";

const decision = {
  decisionId: "decision-1",
  kind: "disruption",
} as unknown as OperationsDecision;

describe("OperationsRegistry", () => {
  it("released nur die Streams einer archivierten Welt idempotent", () => {
    const registry = new OperationsRegistry(3, 2);
    const publicFeed = registry.forOperator("public", "operator-public");
    publicFeed.publish({ worldId: "public", operatorId: "operator-public", sequence: 1, decision });
    registry.forOperator("archived-world", "operator-a");
    registry.forOperator("archived-world", "operator-b");
    expect(registry.size).toBe(3);

    registry.releaseWorld("archived-world");
    registry.releaseWorld("archived-world");

    expect(registry.size).toBe(1);
    expect(registry.forOperator("public", "operator-public")).toBe(publicFeed);
    expect(publicFeed.eventsAfter(0)).toHaveLength(1);
    expect(registry.forOperator("archived-world", "operator-a").eventsAfter(0)).toEqual([]);
  });
});
