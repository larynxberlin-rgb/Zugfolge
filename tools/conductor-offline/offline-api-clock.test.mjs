import { outputPath } from "./paths.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadOfflineKernel } from "./src/wasm-loader.ts";

const root = dirname(fileURLToPath(import.meta.url));
const liveRequire = createRequire(resolve(root, "../../apps/livemap/package.json"));
const viteRequire = createRequire(liveRequire.resolve("vite"));
const { build } = await import(pathToFileURL(viteRequire.resolve("esbuild")).href);
// Bundle only the transport adapter in memory. No HTML/Rust build or alternate
// domain rules: all accepted/rejected transitions below use the actual WASM.
const compiled = await build({ entryPoints: [resolve(root, "src/offline-api.ts")], bundle: true,
  write: false, format: "esm", platform: "node", target: "node24", logLevel: "silent" });
const { createOfflineConductorApi } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
const fixture = JSON.parse(await readFile(resolve(root, "data/fixture.json"), "utf8"));
const art = JSON.parse(await readFile(resolve(root, "data/art-view.json"), "utf8"));
const kernel = await loadOfflineKernel(new Uint8Array(await readFile(resolve(root, "native/kernel.wasm"))));

test("actual WASM adapter pauses hidden/oversized clocks and restores without catch-up", { timeout: 30_000 }, async () => {
  let now = 0, visible = true, waiter, delayedTick;
  const visibilityListeners = new Set(), calls = [], saved = new Map();
  const visibility = { isVisible: () => visible, subscribe(listener) {
    visibilityListeners.add(listener); return () => visibilityListeners.delete(listener);
  } };
  const setVisible = (value) => { visible = value; for (const listener of visibilityListeners) listener(); };
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key) };
  const invoke = async (method, input) => {
    calls.push({ method, elapsedMs: input.elapsedMs });
    if (method === "offline.tick" && delayedTick) {
      const delay = delayedTick; delayedTick = undefined;
      delay.started(); await delay.finish;
    }
    return kernel.invoke(method, input);
  };
  const options = { invoke, fixture, art, atlases: {}, storage, clock: () => now, visibility, pulseMs: 10 };
  let demo = await createOfflineConductorApi(options), controller, stream;
  const command = async (action, revisionDelta = 0) => {
    const available = await demo.api.availability();
    return demo.api.command({ schemaVersion: "conductor-command/v1", worldId: demo.context.worldId,
      trainRunId: demo.context.trainRunId, sessionId: available.sessionId ?? randomUUID(),
      expectedRevision: available.revision + revisionDelta,
      expectedManifestRevision: action.type === "start_session" ? null : available.manifestRevision,
      idempotencyKey: randomUUID(), action });
  };
  const listen = () => {
    controller = new AbortController();
    stream = demo.api.stream(0, controller.signal, (value) => {
      if (waiter) { const resolve = waiter; waiter = undefined; resolve(value); }
    });
  };
  const tick = (at) => { now = at; return new Promise((resolve) => { waiter = resolve; }); };
  const stop = async () => { controller.abort(); await stream; };
  try {
    const started = await command({ type: "start_session" });
    const initialTime = started.snapshot.nowMs;
    listen();
    assert.equal((await tick(120_000)).snapshot.nowMs, initialTime);
    assert.equal(calls.at(-1).elapsedMs, 0);
    assert.equal((await tick(121_000)).snapshot.nowMs, initialTime + 1_000);
    assert.equal(calls.at(-1).elapsedMs, 1_000);

    // Reject a real stale command immediately after another OS interruption.
    // The rejected command must not leave the oversized wall-clock baseline.
    now = 300_000;
    await assert.rejects(command({ type: "move", to: started.snapshot.position, transitionEdgeId: null }, 100),
      (error) => error.code === "conductor_stale_revision");
    assert.equal(calls.at(-1).elapsedMs, 0);
    assert.equal((await tick(301_000)).snapshot.nowMs, initialTime + 2_000);

    setVisible(false);
    const hiddenCallCount = calls.length;
    now = 500_000;
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(calls.length, hiddenCallCount, "hidden tabs must not schedule native ticks");
    setVisible(true);
    assert.equal((await tick(501_000)).snapshot.nowMs, initialTime + 3_000);

    // A visibility event may happen while an async transport reply is pending.
    // It must retain the newer resume baseline after that old reply arrives.
    let releaseTick, tickStarted;
    const began = new Promise((resolve) => { tickStarted = resolve; });
    delayedTick = { started: tickStarted, finish: new Promise((resolve) => { releaseTick = resolve; }) };
    const pending = tick(502_000);
    await began;
    setVisible(false); now = 900_000; setVisible(true);
    releaseTick();
    assert.equal((await pending).snapshot.nowMs, initialTime + 4_000);
    assert.equal((await tick(901_000)).snapshot.nowMs, initialTime + 5_000);

    await stop(); demo.dispose();
    assert.equal(visibilityListeners.size, 0, "dispose removes the visibility handler");
    const savedEnvelope = JSON.parse([...saved.values()][0]);
    assert.throws(() => kernel.invoke("offline.tick", { fixture, checkpoint: savedEnvelope.checkpoint, elapsedMs: 120_000 }),
      /offline_elapsed_out_of_range/u);

    // Restore has no wall-clock timestamp to replay: hidden time remains local.
    now = 10_000_000; visible = false;
    demo = await createOfflineConductorApi(options);
    assert.equal(demo.persistence.restored, true);
    assert.equal((await demo.api.snapshot()).snapshot.nowMs, initialTime + 5_000);
    listen(); now = 20_000_000; setVisible(true);
    assert.equal((await tick(20_001_000)).snapshot.nowMs, initialTime + 6_000);
    await stop();
    const report = { schemaVersion: "conductor-offline-clock-smoke/v1", testOnly: true,
      transport: "embedded-wasm", kernelSha256: kernel.kernelSha256, fixtureHash: demo.context.fixtureHash,
      adapterSha256: createHash("sha256").update(await readFile(resolve(root, "src/offline-api.ts"))).digest("hex"),
      oversizedGapPaused: true, nativeElapsedLimitUnchanged: true, rejectedCommandRecovers: true,
      hiddenTimersPaused: true, inFlightResumePreserved: true, restoreWithoutCatchUp: true,
      actualSimulationAdvanceMs: 6_000, elapsedCalls: calls.filter((call) => call.elapsedMs !== undefined) };
    await writeFile(outputPath("offline-api-clock-report.json"), JSON.stringify(report, null, 2) + "\n");
  } finally {
    if (controller) { controller.abort(); await stream.catch(() => {}); }
    demo.dispose();
  }
});
