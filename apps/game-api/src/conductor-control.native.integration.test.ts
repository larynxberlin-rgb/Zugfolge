import { expect, it } from "vitest";
import { conductorControlStates, conductorTrainStates, ledgerAccounts, ledgerEntries, ledgerTransactions, worlds } from "@zugfolge/db";
import { and, eq } from "drizzle-orm";
import type { ConductorCommandActionV1, ConductorCommandV1, InteriorPointV1 } from "@zugfolge/runtime-native";
import { createFareControlNativeFixture, hasFareControlNative } from "./conductor-control.native-fixture.js";
import { controlRecord, type FareControlState } from "./conductor-control-runtime.js";
import { createConductorControlIntegration } from "./conductor-control.js";
import { createConductorPoliceAdapter } from "./conductor-police.js";
import { ConductorSessionService } from "./conductor-session-service.js";

const nativeIt = hasFareControlNative ? it : it.skip;
nativeIt("führt echte M10-Fahrgäste über Prüfung und Forderung in den unveränderten Ledger und setzt nach Restore fort", async () => {
  const f = await createFareControlNativeFixture();
  try {
    let sequence = 0;
    const start: ConductorCommandV1 = { schemaVersion: "conductor-command/v1", worldId: f.access.worldId, trainRunId: f.access.trainRunId,
      sessionId: "control-native-session", expectedRevision: 0, expectedManifestRevision: null,
      idempotencyKey: "control:start", action: { type: "start_session" } };
    let response = await f.sessions.command(f.access, start);
    const act = async (action: ConductorCommandActionV1) => {
      const command: ConductorCommandV1 = { ...start, idempotencyKey: `control:action:${++sequence}`,
        expectedRevision: response.snapshot.revision, expectedManifestRevision: response.snapshot.pins.manifestRevision, action };
      response = await f.sessions.command(f.access, command); return command;
    };
    const advance = async (milliseconds: number) => {
      f.clock.nowMs += milliseconds; await f.apply(`control:time:${++sequence}`, { type: "advance-to", atMs: f.clock.nowMs }); await f.refresh();
      response = await f.sessions.snapshot(f.access);
    };
    const context = await f.controlContext(), manifests = (context.projectionInput.evaluation["manifests"] as unknown[]).map(controlRecord);
    const manifest = manifests.find((row) => row["trainRunId"] === f.access.trainRunId && row["segmentId"] === response.snapshot.passengers.segmentId)!;
    const facts = new Map((manifest["passengers"] as unknown[]).map(controlRecord).map((row) => [row["passengerKey"], row["fareFact"]]));
    const choices = response.snapshot.passengers.passengers.filter((row) => facts.get(row.passengerKey) !== "valid");
    expect(choices.length).toBeGreaterThan(0);
    const from = response.layout.nodes.find((node) => JSON.stringify(node.point) === JSON.stringify(response.snapshot.position))!;
    const targets = choices.map((passenger) => {
      const interaction = response.layout.interactions.find((row) => row.kind === "passenger" && row.targetId === passenger.placeId)!;
      const path = f.runtimes.interior.path({ schemaVersion: "conductor-interior-path-input/v1", layout: response.layout,
        expectedLayoutHash: response.layout.layoutHash, fromNodeId: from.nodeId, toNodeId: interaction.nodeId, wheelchair: false });
      return { passenger, path };
    }).sort((a, b) => a.path.lengthMm - b.path.lengthMm);
    const selected = targets[0]!;
    for (let index = 1; index < selected.path.nodeIds.length; index++) {
      const node = response.layout.nodes.find((row) => row.nodeId === selected.path.nodeIds[index])!;
      const edge = response.layout.edges.find((row) => row.edgeId === selected.path.edgeIds[index - 1])!;
      await advance(Math.max(1000, Math.ceil(edge.lengthMm * 1000 / 1400)));
      await act({ type: "move", to: node.point as InteriorPointV1, transitionEdgeId: edge.kind === "walk" ? null : edge.edgeId });
    }
    await act({ type: "start_inspection", passengerKey: selected.passenger.passengerKey });
    expect(response.snapshot.activeEncounter?.options.some((option) => option.optionId === "check")).toBe(true);
    await act({ type: "choose_dialogue_option", optionId: "check" });
    expect(response.snapshot.activeEncounter?.hints).toMatchObject({ documentStatus: "not_presentable", identityStatus: "confirmed", acquisitionException: "excluded" });
    await advance(Math.max(1, response.snapshot.activeEncounter!.availableAtMs - f.clock.nowMs));
    const claim = await act({ type: "choose_dialogue_option", optionId: "provisional" });
    const [stored] = await f.db.select().from(conductorControlStates).where(eq(conductorControlStates.worldId, f.access.worldId));
    let state = f.controlRuntime.restore(stored!.state as FareControlState, stored!.stateHash);
    expect(Object.values(state.cases)[0]).toMatchObject({ claimKind: "provisional", claimCents: "6000", costsCents: "100" });
    const count = (await f.db.select().from(ledgerTransactions)).length;
    await f.sessions.command(f.access, claim);
    expect((await f.db.select().from(ledgerTransactions)).length).toBe(count);
    const [train] = await f.db.select().from(conductorTrainStates);
    expect(Object.keys((train!.state as { controlReceipts: object }).controlReceipts)).toHaveLength(1);
    await expect(f.sessions.snapshot({ ...f.access, keycloakSubject: "interior-fixture-other" })).rejects.toMatchObject({ statusCode: 403 });
    const control = createConductorControlIntegration({ runtime: f.controlRuntime, releases: f.controlReleases,
      police: createConductorPoliceAdapter({ runtime: f.native.operational, regionBindings: f.dependencies.regionBindings, controlRuntime: f.controlRuntime }) });
    await advance(20_001);
    await f.db.transaction(async (tx) => { await tx.select().from(worlds).where(eq(worlds.id, f.access.worldId)).for("update"); await control.advanceWorld(tx, f.access.worldId, f.clock.nowMs); });
    const [paid] = await f.db.select().from(conductorControlStates); state = f.controlRuntime.restore(paid!.state as FareControlState, paid!.stateHash);
    expect(Object.values(state.cases)[0]).toMatchObject({ paidCents: facts.get(selected.passenger.passengerKey) === "invalid" ? "6000" : "700" });
    const previousHash = state.stateHash, previousReceipts = Object.keys(state.receipts).length;
    await f.db.transaction(async (tx) => { await control.advanceWorld(tx, f.access.worldId, f.clock.nowMs + 1); });
    const [unchanged] = await f.db.select().from(conductorControlStates);
    expect(unchanged!.stateHash).toBe(previousHash); expect(Object.keys((unchanged!.state as FareControlState).receipts)).toHaveLength(previousReceipts);
    const statuses = await control.publicStatus(f.db, await f.controlContext());
    expect(JSON.stringify(statuses)).not.toMatch(/fareFact|passengerKey|seedHash|inspectionPolicy|responseAfterActivation|identityConfirmed/u);
    const journals = await f.db.select().from(ledgerTransactions);
    const entries = await f.db.select().from(ledgerEntries);
    for (const journal of journals) expect(entries.filter((entry) => entry.transactionId === journal.id).reduce((sum, entry) => sum + entry.amountCents, 0n)).toBe(0n);
    const cash = await f.db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.worldId, f.access.worldId), eq(ledgerAccounts.name, "Economy:Kasse")));
    expect(cash).toHaveLength(1);
    const restoredSessions = new ConductorSessionService({ ...f.dependencies, control });
    expect((await restoredSessions.snapshot(f.access)).snapshot.activeEncounter).toBeNull();
  } finally { await f.dispose(); }
// Lokale Windows-CLI-Belege starten jeden echten Rust-Aufruf als Prozess;
// die Linux-NAPI-CI behält ihr bisheriges Zeitbudget.
}, process.platform === "win32" && process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] === undefined ? 240_000 : 120_000);
