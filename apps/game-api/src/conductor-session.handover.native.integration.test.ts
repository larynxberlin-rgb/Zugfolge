import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { conductorLeases, conductorTrainStates, regionalSimulationStates } from "@zugfolge/db";
import type { OperationalSimulationState } from "@zugfolge/runtime-native";
import { and, eq } from "drizzle-orm";
import { callInteriorFixtureRust } from "./conductor-interior.native-fixture.js";
import { createConductorSessionNativeFixture, hasSessionNativeFixture } from "./conductor-session.native-fixture.js";
import { ConductorSessionService } from "./conductor-session-service.js";

const nativeIt = hasSessionNativeFixture ? it : it.skip;
nativeIt("behält die echte Sitzung über prepare/accept/finish und verlangt beide Pins und passende Quittungen", async () => {
  const fixture = await createConductorSessionNativeFixture({ async evidence() { return { encounterEvidence: [], controlReceipts: [] }; },
    async apply(_tx, _context, _state, effects) { if (effects.length) throw new Error("Der Übergabetest erzeugt keine Kontrolleffekte."); } });
  try {
    const sourceRegionId = fixture.initialization.regionId, targetRegionId = "conductor-native-target";
    const target = fixture.native.operational.initialize({ ...fixture.initialization, regionId: targetRegionId, nowMs: fixture.clock.nowMs,
      vehicleTypes: [], vehicles: [], formations: [], trains: [] });
    const pins = [...fixture.dependencies.regionBindings(fixture.access.worldId), { regionId: targetRegionId, initializationHash: target.initializationHash }];
    // Nur fiktive, unabhängig gepinnte Testregion; keine erfundene Szenenfreigabe.
    const dependencies = { ...fixture.dependencies, scenes: undefined, regionBindings: () => pins };
    const sessions = new ConductorSessionService(dependencies);
    const started = await sessions.command(fixture.access, { schemaVersion: "conductor-command/v1", worldId: fixture.access.worldId,
      trainRunId: fixture.access.trainRunId, sessionId: "handover-session", expectedRevision: 0, expectedManifestRevision: null,
      idempotencyKey: "handover:start", action: { type: "start_session" } });
    const sessionBefore = (await fixture.db.select().from(conductorTrainStates))[0]!;
    const [sourceHead] = await fixture.db.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, fixture.access.worldId), eq(regionalSimulationStates.regionId, sourceRegionId)));
    const envelope = (state: unknown, expectedInitializationHash: string) => ({ schemaVersion: "zugfolge-operational-simulation-restore/v2", state, expectedInitializationHash });
    const input = { schemaVersion: "zugfolge-operational-handover-input/v1", source: envelope(sourceHead!.state, sourceHead!.initializationHash!),
      target: envelope(target.state, target.initializationHash), handoverId: "test-only:actual-transfer", trainRunId: fixture.access.trainRunId,
      protectedResources: [Object.keys((sourceHead!.state as OperationalSimulationState).world["resourceLifecycle"] as object)[0]!] };
    const path = join(fixture.directory, "operational-infrastructure-v2.json");
    const native = (value: unknown) => {
      const addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"];
      if (addonPath !== undefined) return JSON.parse((createRequire(import.meta.url)(addonPath) as {
        handoverOperationalSimulation(input: string, path: string): string }).handoverOperationalSimulation(JSON.stringify(value), path));
      const binary = process.env["ZUGFOLGE_OPERATIONAL_TEST_BINARY"] ?? resolve(fileURLToPath(new URL("../../../", import.meta.url)),
        `target/debug/examples/operational_json${process.platform === "win32" ? ".exe" : ""}`);
      return JSON.parse(callInteriorFixtureRust(binary, [], { method: "handover", args: [JSON.stringify(value), path] }));
    };
    const transfer = native(input) as { sourcePrepared: OperationalSimulationState; targetAccepted: OperationalSimulationState; sourceFinished: OperationalSimulationState };
    expect(native(input)).toEqual(transfer);
    expect(() => native({ ...input, target: envelope(target.state, "f".repeat(64)) })).toThrow("operational_handover_invalid");
    const put = async (state: OperationalSimulationState) => {
      // Nur unveränderte Native-Ergebnisse; Korruption unten ist ausdrücklich negativ.
      const row = { worldId: fixture.access.worldId, regionId: state.world.regionId, stateSchema: state.schemaVersion, state,
        initializationHash: state.initializationHash, stateHash: state.stateHash, revision: state.revision,
        publisherSequence: state.publisherSequence, createdAt: new Date(fixture.clock.nowMs), updatedAt: new Date(fixture.clock.nowMs) };
      await fixture.db.insert(regionalSimulationStates).values(row).onConflictDoUpdate({ target: [regionalSimulationStates.worldId, regionalSimulationStates.regionId], set: row });
    };
    const unchanged = async () => {
      expect((await fixture.db.select().from(conductorTrainStates))[0]!.stateHash).toBe(sessionBefore.stateHash);
      expect(await fixture.db.select().from(conductorLeases)).toHaveLength(1);
    };
    for (const state of [transfer.sourcePrepared, transfer.targetAccepted, transfer.sourceFinished])
      expect(fixture.native.operational.restore(state, state.initializationHash).stateHash).toBe(state.stateHash);
    await put(transfer.sourcePrepared);
    await expect(sessions.sweepWorld(fixture.access.worldId)).resolves.toBeUndefined(); await unchanged();
    await expect(sessions.snapshot(fixture.access)).rejects.toMatchObject({ code: "conductor_handover_pending" }); await unchanged();
    await put(transfer.targetAccepted);
    await expect(sessions.sweepWorld(fixture.access.worldId)).resolves.toBeUndefined(); await unchanged();
    await expect(sessions.snapshot(fixture.access)).rejects.toMatchObject({ code: "conductor_handover_pending" }); await unchanged();
    for (const altered of [{ revision: sessionBefore.revision + 1 }, { atMs: sessionBefore.atMs + 1 }]) {
      await fixture.db.update(conductorTrainStates).set(altered).where(eq(conductorTrainStates.worldId, fixture.access.worldId));
      await expect(sessions.sweepWorld(fixture.access.worldId)).rejects.toMatchObject({ code: "conductor_state_invalid" });
      await fixture.db.update(conductorTrainStates).set({ revision: sessionBefore.revision, atMs: sessionBefore.atMs }).where(eq(conductorTrainStates.worldId, fixture.access.worldId));
    }
    await put(transfer.sourceFinished);
    const missingPin = new ConductorSessionService({ ...dependencies, regionBindings: () => pins.slice(0, 1) });
    await expect(missingPin.snapshot(fixture.access)).rejects.toMatchObject({ code: "conductor_source_unavailable" }); await unchanged();
    const wrongPin = new ConductorSessionService({ ...dependencies, regionBindings: () => pins.map((pin) => pin.regionId === targetRegionId ? { ...pin, initializationHash: "f".repeat(64) } : pin) });
    await expect(wrongPin.snapshot(fixture.access)).rejects.toMatchObject({ code: "conductor_source_unavailable" }); await unchanged();
    for (const corruption of ["missing-source", "wrong-target"] as const) {
      const altered = structuredClone(corruption === "missing-source" ? transfer.sourceFinished : transfer.targetAccepted);
      if (corruption === "missing-source") delete altered.world["finishedHandoverReceipts"];
      else (altered.world["acceptedHandovers"] as Record<string, string>)[input.handoverId] = "0".repeat(64);
      await put(altered);
      await expect(sessions.snapshot(fixture.access)).rejects.toMatchObject({ code: "conductor_source_unavailable" }); await unchanged();
      await put(corruption === "missing-source" ? transfer.sourceFinished : transfer.targetAccepted);
    }
    const resumed = await sessions.snapshot(fixture.access);
    expect(resumed.snapshot).toMatchObject({ status: "active", sessionId: started.snapshot.sessionId, position: started.snapshot.position });
    expect(resumed.snapshot.passengers).toEqual(started.snapshot.passengers);
    expect((await fixture.db.select().from(conductorTrainStates))[0]!.regionId).toBe(targetRegionId);
    expect(await fixture.db.select().from(conductorLeases)).toHaveLength(1);
    const restored = await new ConductorSessionService(dependencies).snapshot(fixture.access);
    expect(restored.snapshot.snapshotHash).toBe(resumed.snapshot.snapshotHash);
  } finally { await fixture.dispose(); }
}, 120_000);
