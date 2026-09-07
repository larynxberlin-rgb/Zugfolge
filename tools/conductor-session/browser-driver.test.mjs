import assert from "node:assert/strict";
import test from "node:test";
import { operationalEventTimes } from "./browser-driver.mjs";

test("a terminal arrival may leave only the actual fare-control calendar pending", () => {
  const world = { scheduledMotionEnds: [], scheduledContinuationDue: [], scheduledPassengerDepartures: [],
    fareControlState: { scheduled: [{ atMs: 5_400_000, trainId: "terminal-test" }] } };
  assert.deepEqual(operationalEventTimes(world), [5_400_000]);
});
