import { outputPath } from "./paths.mjs";
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker as NativeWorker } from 'node:worker_threads';

const root = dirname(fileURLToPath(import.meta.url));
const liveRequire = createRequire(resolve(root, '../../apps/livemap/package.json'));
const viteRequire = createRequire(liveRequire.resolve('vite'));
const { build } = await import(pathToFileURL(viteRequire.resolve('esbuild')).href);
// Exercise the exact minified Blob source used by the browser, on an isolated
// thread. This adapter changes only postMessage wiring, never kernel behavior.
let browserWorker;
globalThis.Worker = class {
  constructor(url) {
    browserWorker = this;
    this.fatal = new Promise(resolve => { this.resolveFatal = resolve; });
    this.ready = fetch(url).then(response => response.text()).then(source => {
      const worker = new NativeWorker(`const { parentPort } = require('node:worker_threads');
        globalThis.postMessage = value => parentPort.postMessage(value);
        parentPort.on('message', data => {
          if (data?.__workerSmokeFatal === true) throw new Error('worker-smoke-induced-fatal-error');
          globalThis.onmessage({data});
        });\n${source}`, { eval: true });
      worker.on('message', data => this.onmessage?.({ data }));
      worker.on('error', error => {
        this.onerror?.(error);
        this.resolveFatal(error);
      });
      return worker;
    });
  }
  postMessage(value, transfer) { void this.ready.then(worker => worker.postMessage(value, transfer)); }
  terminate() { void this.ready.then(worker => worker.terminate()); }
  crash() { this.postMessage({ __workerSmokeFatal: true }); }
};
async function bounded(promise, label) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} hung after a fatal worker error`)), 2000);
    })]);
  } finally { clearTimeout(timeout); }
}
const compiled = await build({ entryPoints: [resolve(root, 'src/wasm-loader.ts')], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2022', minify: true, logLevel: 'silent' });
const { loadOfflineKernelWorker, loadOfflineKernel } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const fixture = JSON.parse(await readFile(resolve(root, 'data/fixture.json'), 'utf8'));
const scene = JSON.parse(await readFile(resolve(root, 'data/scene.json'), 'utf8'));
const bytes = new Uint8Array(await readFile(resolve(root, 'native/kernel.wasm')));
const kernel = await loadOfflineKernelWorker(bytes, fixture, scene);
const heartbeat = [], started = performance.now();
let last = started;
const timer = setInterval(() => { const now = performance.now(); heartbeat.push(now - last); last = now; }, 5);
try {
  let result = await kernel.invoke('offline.initialize', { fixture });
  assert.equal(result.checkpoint.schemaVersion, 'offline-worker-checkpoint/v1');
  assert.ok(JSON.stringify(result.checkpoint).length < 100);
  const sessionId = randomUUID();
  const command = action => ({ schemaVersion: 'conductor-command/v1', worldId: result.context.worldId,
    trainRunId: result.context.trainRunId, sessionId, expectedRevision: result.availability.revision,
    expectedManifestRevision: action.type === 'start_session' ? null : result.availability.manifestRevision,
    idempotencyKey: randomUUID(), action });
  result = await kernel.invoke('offline.command', { fixture, checkpoint: result.checkpoint, elapsedMs: 0,
    command: command({ type: 'start_session' }) });
  assert.ok(result.response.scene);
  const before = structuredClone(result.response.scene), layout = result.response.layout;
  assert.deepEqual(scene.release.stations.map(station => station.name), ['Ährenfeld', 'Südstadt', 'Hauptbahnhof']);
  assert.equal(before.station.name, 'Ährenfeld', 'native projection uses the authored practice name');
  const views = [];
  for (let step = 0; step < 10; step++) {
    result = await kernel.invoke('offline.tick', { fixture, checkpoint: result.checkpoint, elapsedMs: 1000 });
    assert.equal(result.response.layout, layout, 'one cached layout instance, no repeated structured transfer');
    views.push({ atMs: result.response.scene.atMs, routeMm: result.response.scene.routeMm,
      speedMmps: result.response.scene.speedMmps });
  }
  assert.ok(views.at(-1).routeMm > before.routeMm, 'actual native outdoor position advances');
  const save = await kernel.exportSave(), saved = JSON.parse(save);
  assert.equal(saved.checkpoint.schemaVersion, 'conductor-offline-checkpoint/v1');
  assert.ok(saved.checkpoint.source.operationalWorld);
  const restored = await kernel.invoke('offline.restore', { checkpoint: saved.checkpoint });
  assert.deepEqual(restored.response, result.response, 'native restore including original scene is exact');
  await assert.rejects(kernel.invoke('offline.tick', { checkpoint: result.checkpoint, elapsedMs: 0 }), /offline_worker_stale_checkpoint/);
  clearInterval(timer);
  const adapterBundle = await build({ entryPoints: [resolve(root, 'src/offline-api.ts')], bundle: true, write: false,
    format: 'esm', platform: 'node', target: 'node24', logLevel: 'silent' });
  const { createOfflineConductorApi } = await import(`data:text/javascript;base64,${Buffer.from(adapterBundle.outputFiles[0].contents).toString('base64')}`);
  const storageKey = 'worker-test-only', saves = new Map([[storageKey, save]]);
  const storage = { getItem: key => saves.get(key) ?? null, setItem: (key, value) => saves.set(key, value), removeItem: key => saves.delete(key) };
  const art = JSON.parse(await readFile(resolve(root, 'data/art-view.json'), 'utf8'));
  const options = { invoke: kernel.invoke, exportSave: kernel.exportSave, fixture, art, atlases: {}, storage, storageKey };
  let api = await createOfflineConductorApi(options);
  const available = await api.api.availability();
  const detached = await api.api.command({ schemaVersion: 'conductor-command/v1', worldId: api.context.worldId,
    trainRunId: api.context.trainRunId, sessionId: available.sessionId, expectedRevision: available.revision,
    expectedManifestRevision: available.manifestRevision, idempotencyKey: randomUUID(), action: { type: 'detach_session' } });
  assert.equal(detached.snapshot.status, 'detached');
  assert.equal(JSON.parse(saves.get(storageKey)).checkpoint.schemaVersion, 'conductor-offline-checkpoint/v1');
  api.dispose();
  api = await createOfflineConductorApi(options);
  assert.deepEqual(await api.api.snapshot(), detached, 'asynchronous save restores the actual detached response');
  api.dispose();
  // Measure the same ten original high-level transitions synchronously for a
  // main-thread comparison. This is an explicit benchmark, not gameplay time.
  const direct = await loadOfflineKernel(bytes);
  let baseline = saved.checkpoint;
  const baselineStart = performance.now();
  for (let step = 0; step < 10; step++) baseline = (await direct.invoke('offline.tick', { fixture, checkpoint: baseline, elapsedMs: 1 })).checkpoint;
  const baselineBlockedMs = performance.now() - baselineStart;
  // The fatal event comes from the real worker thread. Queue both calls behind
  // the crashing transport message, so neither can obtain a native response.
  // This must also fence later calls instead of leaving fresh promises pending.
  browserWorker.crash();
  const waitingInvoke = kernel.invoke('offline.report', { checkpoint: restored.checkpoint });
  const waitingSave = kernel.exportSave();
  await bounded(Promise.all([
    assert.rejects(waitingInvoke, /offline_worker_failed/),
    assert.rejects(waitingSave, /offline_worker_failed/),
  ]), 'Existing invoke/exportSave');
  const fatal = await bounded(browserWorker.fatal, 'Worker error event');
  assert.equal(fatal.message, 'worker-smoke-induced-fatal-error');
  await bounded(Promise.all([
    assert.rejects(kernel.invoke('offline.report', { checkpoint: restored.checkpoint }), /offline_worker_failed/),
    assert.rejects(kernel.exportSave(), /offline_worker_failed/),
  ]), 'New invoke/exportSave');
  const report = { schemaVersion: 'conductor-offline-worker-smoke/v1', testOnly: true, fixtureHash: result.context.fixtureHash,
    kernelSha256: kernel.kernelSha256, sceneReleaseHash: scene.releaseHash, passengers: result.response.snapshot.passengers.passengers.length,
    nativeSceneBefore: { atMs: before.atMs, routeMm: before.routeMm, speedMmps: before.speedMmps, station: before.station.name }, nativeSceneSteps: views,
    privateCheckpointExcludedFromRenderResponses: true, saveContainsPrivateCheckpoint: true,
    checkpointTokenBytes: JSON.stringify(result.checkpoint).length,
    realSaveBytes: Buffer.byteLength(save), restoreEqual: true, staleTokenRejected: true, asynchronousSaveRestoreEqual: true,
    actualFatalWorkerEvent: fatal.message, waitingCallsRejectedAfterFatalError: true, newCallsRejectedAfterFatalError: true,
    mainThreadHeartbeatCount: heartbeat.length, mainThreadHeartbeatMaxIntervalMs: Math.max(...heartbeat),
    directTenTransitionBlockedMs: baselineBlockedMs, workerSamples: kernel.performance() };
  await writeFile(outputPath("worker-smoke-report.json"), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
} finally { clearInterval(timer); kernel.dispose(); }
