/** Self-contained after bundling: this function runs inside the embedded Blob worker. */
export function installOfflineWorker(loadKernel: (bytes: Uint8Array) => Promise<{ invoke: (command: string, input: unknown) => unknown | Promise<unknown>; kernelSha256: string }>) {
  const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(value: unknown): void };
  let kernel: Awaited<ReturnType<typeof loadKernel>>;
  let fixture: any, scene: any, checkpoint: any, context: any;
  let token = 0, layoutHash: string | null = null, checkpointToken: string | null = null;
  let tail = Promise.resolve();
  const record = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value);
  async function projectScene(result: any, candidate: any) {
    if (!scene || !result.response || result.response.snapshot.status === 'ended') return;
    const source = candidate.source;
    // Re-project the already committed world at exactly its existing time.
    // The returned world is never substituted into the checkpoint.
    const operational: any = await kernel.invoke('operation.advance', { world: source.operationalWorld,
      infrastructure: fixture.infrastructure, atMs: source.operationalWorld.nowMs });
    if (operational.worldHash !== source.expectedOperationalWorldHash) throw new Error('offline_scene_world_changed');
    const snapshot = result.response.snapshot;
    const binding = { worldId: snapshot.worldId, periodId: source.sessionPolicy.periodId, operatorId: snapshot.operatorId,
      trainRunId: snapshot.trainRunId, regionId: operational.liveMap.regionId, infraReleaseId: operational.liveMap.infraReleaseId,
      infraReleaseHash: scene.infrastructureStateHash, sceneReleaseHash: scene.releaseHash,
      artReleaseId: result.response.layout.binding.artReleaseId, artManifestHash: result.response.layout.binding.artManifestHash,
      operationalStateHash: operational.worldHash, commitSequence: operational.liveMap.commitSequence, validFromMs: 0, validUntilMs: 86_400_000 };
    result.response.scene = await kernel.invoke('scene.project', { schemaVersion: 'conductor-scene-input/v1', binding,
      sceneRelease: scene.release, operational: operational.liveMap, sampleAtMs: operational.liveMap.atMs });
  }
  async function handle(message: any) {
    const started = performance.now();
    if (message.kind === 'boot') {
      fixture = message.fixture; scene = message.scene;
      kernel = await loadKernel(new Uint8Array(message.bytes));
      return { kernelSha256: kernel.kernelSha256 };
    }
    if (!kernel) throw new Error('offline_worker_not_ready');
    if (message.kind === 'save') {
      if (!checkpoint || !context) throw new Error('offline_checkpoint_missing');
      const text = JSON.stringify({ schemaVersion: 'conductor-offline-save/v1', context, checkpoint });
      if (text.length > 32 * 1024 * 1024) throw new Error('offline_save_too_large');
      return { text, checkpointToken, serializationMs: performance.now() - started };
    }
    if (message.kind !== 'invoke' || typeof message.command !== 'string' || !message.command.startsWith('offline.')) throw new Error('offline_worker_command_invalid');
    const input = { ...message.input, fixture };
    if (message.command !== 'offline.initialize') {
      if (record(input.checkpoint) && input.checkpoint.schemaVersion === 'offline-worker-checkpoint/v1') {
        if (input.checkpoint.token !== checkpointToken || checkpoint === undefined) throw new Error('offline_worker_stale_checkpoint');
        input.checkpoint = checkpoint;
      } else if (message.command !== 'offline.restore') throw new Error('offline_worker_checkpoint_invalid');
    }
    const nativeStarted = performance.now();
    const result: any = await kernel.invoke(message.command, input);
    const nativeMs = performance.now() - nativeStarted;
    if (record(result) && Object.hasOwn(result, 'checkpoint')) {
      // Keep the private native state and all its JSON work on this worker.
      const candidate = result.checkpoint;
      await projectScene(result, candidate);
      checkpoint = candidate; context = result.context; checkpointToken = String(++token);
      result.checkpoint = { schemaVersion: 'offline-worker-checkpoint/v1', token: checkpointToken };
      if (result.response?.layout) {
        if (layoutHash === result.response.layout.layoutHash) result.response.layout = { offlineLayoutReference: layoutHash };
        else layoutHash = result.response.layout.layoutHash;
      }
    }
    return { result, metrics: { command: message.command, nativeMs, workerMs: performance.now() - started } };
  }
  scope.onmessage = (event) => {
    const message = event.data;
    tail = tail.then(async () => {
      try { scope.postMessage({ id: message.id, ok: true, value: await handle(message) }); }
      catch (error) { const code = error instanceof Error ? error.message : '';
        scope.postMessage({ id: message.id, ok: false, error: /^[a-z][a-z0-9_]{1,100}$/.test(code) ? code : 'offline_worker_failed' }); }
    });
  };
}
