import { describe, expect, it } from "vitest";

import { ACTIVITY_POLICY_SCHEMA, calculateStrongActivity, validateActivityPolicy } from "./activity-policy.js";

const POLICY = {
  schemaVersion: ACTIVITY_POLICY_SCHEMA,
  windowSeconds: 100,
  minimumScore: 3,
  weights: { "operations.train-outcome": 2, "economy.settlement": 1 },
} as const;

describe("ActivityPolicy", () => {
  it("ist ohne fachliche Freigabe explizit unconfigured", () => {
    expect(calculateStrongActivity(null, [], [], 500)).toEqual({
      status: "unconfigured", stronglyActiveOperatorIds: [], scores: {}, asOfS: 500,
    });
  });

  it("wertet die linke Fenstergrenze exklusiv und die rechte inklusiv", () => {
    const result = calculateStrongActivity(POLICY, [{ operatorId: "evu", kind: "player", lifecycle: "active" }], [
      { operatorId: "evu", eventType: "operations.train-outcome", occurredAtS: 400 },
      { operatorId: "evu", eventType: "operations.train-outcome", occurredAtS: 401 },
      { operatorId: "evu", eventType: "economy.settlement", occurredAtS: 500 },
      { operatorId: "evu", eventType: "economy.settlement", occurredAtS: 501 },
    ], 500);
    expect(result.stronglyActiveOperatorIds).toEqual(["evu"]);
    expect(result.scores).toEqual({ evu: 3 });
  });

  it("schliesst System-EVU, Bots, ausgeschiedene und geloeschte EVU aus", () => {
    const operators = [
      { operatorId: "player", kind: "player", lifecycle: "active" },
      { operatorId: "system", kind: "system", lifecycle: "active" },
      { operatorId: "bot", kind: "bot", lifecycle: "active" },
      { operatorId: "exited", kind: "player", lifecycle: "exited" },
      { operatorId: "deleted", kind: "player", lifecycle: "deleted" },
    ] as const;
    const events = operators.flatMap(({ operatorId }) => [
      { operatorId, eventType: "operations.train-outcome", occurredAtS: 450 },
      { operatorId, eventType: "economy.settlement", occurredAtS: 451 },
    ]);
    expect(calculateStrongActivity(POLICY, operators, events, 500).stronglyActiveOperatorIds).toEqual(["player"]);
  });

  it.each(["identity.login", "browser.page-open", "presence.online"])("verwirft %s als Aktivitaetsbeleg", (eventType) => {
    expect(() => validateActivityPolicy({ ...POLICY, weights: { [eventType]: 1 } })).toThrow(/Nicht autoritativer/);
  });
});
