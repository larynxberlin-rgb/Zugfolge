import kernelBytes from "../native/kernel.wasm?bytes";
import fixture from "../data/fixture.json";
import scene from "../data/scene.json";
import practice from "../data/practice-public.json";
import { art, atlases } from "./assets.js";
import { createOfflineConductorApi } from "./offline-api.js";
import { loadOfflineKernelWorker } from "./wasm-loader.js";

/** Standalone file:// composition. This namespace cannot touch an online game's persistence. */
export async function createOfflineDemo() {
  const kernel = await loadOfflineKernelWorker(kernelBytes, fixture, scene);
  let session;
  try { session = await createOfflineConductorApi({ invoke: kernel.invoke, exportSave: kernel.exportSave, fixture, art, atlases }); }
  catch (error) { kernel.dispose(); throw error; }
  if (practice.fixtureHash !== session.context.fixtureHash) { session.dispose(); kernel.dispose(); throw new Error("offline_practice_binding_mismatch"); }
  const policy = fixture.source.sessionPolicy;
  return {
    ...session,
    trainLabel: "Regionalzug · lokale Übungsfahrt",
    worldLabel: "Offline-Demo",
    operatorLabel: "Übungsbetrieb",
    metadata: Object.freeze({ schemaVersion: "conductor-offline-metadata/v1", testOnly: true,
      fixtureHash: session.context.fixtureHash, kernelSha256: kernel.kernelSha256,
      artReleaseId: art.releaseId, artManifestSha256: art.manifestSha256,
      execution: "dedicated-worker", sceneReleaseHash: scene.releaseHash,
      movementPolicy: { walkSpeedMmPerSecond: policy.walkSpeedMmPerSecond, maxMovementBurstMm: policy.maxMovementBurstMm,
        minCommandIntervalMs: policy.minCommandIntervalMs, inspectionRangeMm: policy.inspectionRangeMm },
      practicePassengers: practice.targets.map(({ passengerKey, label }) => ({ passengerKey, label })) }),
    snapshot: () => session.api.snapshot(),
    performance: kernel.performance,
    dispose: () => { session.dispose(); kernel.dispose(); },
  };
}

/** Explicit recovery action for a rejected local checkpoint; no automatic reset hides restore failure. */
export function clearOfflineDemoSave(): void {
  const storage = globalThis.localStorage;
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) if (key?.startsWith("zugfolge-m15-offline:")) storage.removeItem(key);
}
