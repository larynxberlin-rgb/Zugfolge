import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { mapReleaseStartPreflightMode, startAfterMapReleasePreflight } from "./start-after-map-release-preflight.mjs";

function childProcess(exit = { code: 0, signal: null }) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  if (exit !== null) queueMicrotask(() => {
    child.exitCode = exit.code;
    child.signalCode = exit.signal;
    child.emit("exit", exit.code, exit.signal);
  });
  return child;
}

test("starts the child only after an active-candidate preflight", async () => {
  const calls = [];
  const environment = {
    MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID: "infra-deutschland-2026.2",
    MAP_RELEASE_START_PREFLIGHT_MODE: "active-candidate",
  };
  const exitCode = await startAfterMapReleasePreflight({
    command: ["node", "server.js"],
    environment,
    preflight: async (options) => calls.push(["preflight", options]),
    spawn: (program, args, options) => {
      calls.push(["spawn", { program, args, options }]);
      return childProcess();
    },
    signalSource: new EventEmitter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(calls[0][0], "preflight");
  assert.equal(calls[0][1].mode, "active-candidate");
  assert.equal(calls[0][1].environment, environment);
  assert.equal(calls[1][0], "spawn");
  assert.equal(calls[1][1].program, "node");
  assert.deepEqual(calls[1][1].args, ["server.js"]);
  assert.equal(calls[1][1].options.env, environment);
});

test("fails closed without spawning when the per-process preflight fails", async () => {
  let spawned = false;
  await assert.rejects(
    startAfterMapReleasePreflight({
      command: ["node", "server.js"],
      environment: { MAP_RELEASE_START_PREFLIGHT_MODE: "active-candidate" },
      preflight: async () => { throw new Error("pointer mismatch"); },
      spawn: () => { spawned = true; return childProcess(); },
      signalSource: new EventEmitter(),
    }),
    /pointer mismatch/,
  );
  assert.equal(spawned, false);
});

test("forwards termination signals to the verified child", async () => {
  const signals = new EventEmitter();
  const child = childProcess(null);
  const started = startAfterMapReleasePreflight({
    command: ["node", "server.js"],
    environment: { MAP_RELEASE_START_PREFLIGHT_MODE: "active-candidate" },
    preflight: async () => undefined,
    spawn: () => child,
    signalSource: signals,
  });
  await new Promise((accept) => setImmediate(accept));
  signals.emit("SIGTERM");
  assert.equal(await started, 143);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("accepts rollback only as an explicit pre-activation mode and has no fallback", () => {
  assert.equal(mapReleaseStartPreflightMode({ MAP_RELEASE_START_PREFLIGHT_MODE: "active-candidate" }), "active-candidate");
  assert.equal(mapReleaseStartPreflightMode({ MAP_RELEASE_START_PREFLIGHT_MODE: "pre-activation" }), "pre-activation");
  assert.throws(() => mapReleaseStartPreflightMode({}), /muss explizit/);
  assert.throws(() => mapReleaseStartPreflightMode({ MAP_RELEASE_START_PREFLIGHT_MODE: "automatic" }), /muss explizit/);
});

test("wrong pointer and explicit mode combinations fail before the child starts", async () => {
  const evidence = { releaseId: "infra-deutschland-2026.2", previousReleaseId: "infra-deutschland-2026.1" };
  for (const [mode, activeReleaseId] of [
    ["active-candidate", evidence.previousReleaseId],
    ["pre-activation", evidence.releaseId],
  ]) {
    let spawned = false;
    await assert.rejects(startAfterMapReleasePreflight({
      command: ["node", "server.js"],
      environment: {
        MAP_RELEASE_START_PREFLIGHT_MODE: mode,
        MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID: activeReleaseId,
      },
      preflight: async ({ mode: requestedMode, environment }) => {
        const expected = requestedMode === "active-candidate" ? evidence.releaseId : evidence.previousReleaseId;
        if (environment.MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID !== expected) throw new Error("mode/pointer mismatch");
      },
      spawn: () => { spawned = true; return childProcess(); },
      signalSource: new EventEmitter(),
    }), /mode\/pointer mismatch/);
    assert.equal(spawned, false);
  }
});
