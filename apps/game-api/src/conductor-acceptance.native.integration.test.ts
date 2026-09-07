import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { OPERATIONAL_SIMULATION_COMMAND_SCHEMA, type ConductorCommandActionV1, type ConductorCommandV1,
  type OperationalSimulationCommandPayload, type OperationalSimulationState } from "@zugfolge/runtime-native";
import { regionalSimulationStates } from "@zugfolge/db";
import { and, eq } from "drizzle-orm";
import { createConductorAcceptanceNativeFixture } from "./conductor-acceptance.native-fixture.js";
import { hasFareControlNative } from "./conductor-control.native-fixture.js";
import { controlRecord } from "./conductor-control-runtime.js";

const nativeIt = hasFareControlNative ? it : it.skip;
nativeIt("bindet den gemeinsamen Originalkorpus an einen tatsächlichen M6-Abschluss mit idempotentem Ledger", async () => {
  const f = await createConductorAcceptanceNativeFixture();
  try {
    await f.apply("acceptance:actual-source-closure", { type: "activate-disruption", disruptionId: "acceptance:source-closure",
      effect: { "resource-closed": { resourceId: "block:stop:2" } } });
    await f.refresh();
    const context = await f.controlContext();
    const terminalStopId = String(controlRecord((context.projectionInput.service["stops"] as unknown[]).at(-1))["stopId"]);
    const original = (await f.originalDialogueCandidates()).filter((row) => row.alightingStopId === terminalStopId);
    const inspection = await f.inspectionCandidates({ all: true });
    const evidence = new Map(inspection.map((row) => [String(row["passengerKey"]), row["evidence"]]));
    const selected = original.filter((row) => row.presentation === "admission" && row.fareFact === "invalid"
      || ["empty_phone", "defective_phone", "technical_issue"].includes(row.presentation) && row.fareFact !== "valid")
      .map((row) => ({ ...row, evidence: evidence.get(row.passengerKey) }));
    expect(selected.some((row) => row.presentation === "admission" && row.tone === "friendly"
      && controlRecord(row.evidence)["identityStatus"] === "confirmed")).toBe(true);
    for (const fact of ["invalid", "valid_unpresentable"]) expect(selected.some((row) => row.presentation === "empty_phone"
      && row.fareFact === fact && controlRecord(row.evidence)["identityStatus"] === "confirmed")).toBe(true);
    const police = original.filter((row) => row.fareFact === "invalid" && controlRecord(evidence.get(row.passengerKey))["identityStatus"] === "refused")
      .sort((a, b) => Number(inspection.find((row) => row["passengerKey"] === a.passengerKey)!["pathLengthMm"])
        - Number(inspection.find((row) => row["passengerKey"] === b.passengerKey)!["pathLengthMm"]))[0];
    expect(police).toBeDefined();
    let serial = 0;
    const start: ConductorCommandV1 = { schemaVersion: "conductor-command/v1", worldId: f.access.worldId, trainRunId: f.access.trainRunId,
      sessionId: "acceptance-control-components", expectedRevision: 0, expectedManifestRevision: null,
      idempotencyKey: "acceptance:start", action: { type: "start_session" } };
    let response = await f.sessions.command(f.access, start);
    const command = async (action: ConductorCommandActionV1) => {
      try {
        response = await f.sessions.command(f.access, { ...start, idempotencyKey: `acceptance:action:${++serial}`,
          expectedRevision: response.snapshot.revision, expectedManifestRevision: response.snapshot.pins.manifestRevision, action });
      } catch (cause) { throw new Error(`Abnahmebefehl ${action.type}${"optionId" in action ? `/${action.optionId}` : ""} wurde abgelehnt.`, { cause }); }
    };
    const advance = async (atMs: number, snapshot = true) => {
      f.clock.nowMs = atMs;
      await f.apply(`acceptance:clock:${++serial}`, { type: "advance-to", atMs });
      await f.advanceControl();
      if (snapshot) { await f.refresh(); response = await f.sessions.snapshot(f.access); }
    };
    const passenger = response.snapshot.passengers.passengers.find((row) => row.passengerKey === police!.passengerKey)!;
    const target = response.layout.interactions.find((row) => row.targetId === (passenger.spaceNeeds === "wheelchair" ? passenger.spaceId : passenger.placeId))!;
    const path = f.runtimes.interior.path({ schemaVersion: "conductor-interior-path-input/v1", layout: response.layout,
      expectedLayoutHash: response.layout.layoutHash, fromNodeId: response.layout.entranceNodeId, toNodeId: target.nodeId, wheelchair: false });
    const policy = f.dependencies.sessionReleases.resolve(f.access.worldId, context.period.periodId)!.policy;
    for (let index = 1; index < path.nodeIds.length;) {
      const edge = response.layout.edges.find((row) => row.edgeId === path.edgeIds[index - 1])!;
      let last = index, length = edge.lengthMm;
      const origin = response.snapshot.position;
      if (edge.kind === "walk") for (let next = index + 1; next < path.nodeIds.length; next++) {
        const candidate = response.layout.edges.find((row) => row.edgeId === path.edgeIds[next - 1])!;
        const point = response.layout.nodes.find((row) => row.nodeId === path.nodeIds[next])!.point;
        if (candidate.kind !== "walk" || point.vehicleId !== origin.vehicleId || point.bodyId !== origin.bodyId || point.deckId !== origin.deckId
          || point.xMm !== origin.xMm && point.yMm !== origin.yMm || length + candidate.lengthMm > policy.maxMovementBurstMm) break;
        length += candidate.lengthMm; last = next;
      }
      const point = response.layout.nodes.find((row) => row.nodeId === path.nodeIds[last])!.point;
      await advance(f.clock.nowMs + Math.max(1000, Math.ceil(length * 1000 / policy.walkSpeedMmPerSecond)));
      await command({ type: "move", to: point, transitionEdgeId: edge.kind === "walk" ? null : edge.edgeId });
      index = last + 1;
    }
    await command({ type: "start_inspection", passengerKey: passenger.passengerKey });
    await command({ type: "choose_dialogue_option", optionId: "check" });
    expect(response.snapshot.activeEncounter!.hints).toMatchObject({ documentStatus: "verified_invalid", identityStatus: "refused" });
    await advance(response.snapshot.activeEncounter!.availableAtMs);
    const [before] = await f.db.select().from(regionalSimulationStates).where(and(eq(regionalSimulationStates.worldId, f.access.worldId),
      eq(regionalSimulationStates.regionId, f.initialization.regionId)));
    let baseline = f.native.operational.restore(before!.state as OperationalSimulationState, before!.initializationHash!);
    const baselineStartStateHash = baseline.stateHash;
    await command({ type: "request_police", optionId: "police" });
    await command({ type: "end_session" });
    const middleStopId = String(controlRecord((context.projectionInput.service["stops"] as unknown[])[1])["stopId"]);
    expect(controlRecord(controlRecord((await f.sessions.report(f.access)).control)["hold"])["targetStopId"]).toBe(middleStopId);
    const resume: OperationalSimulationCommandPayload[] = [
      { type: "clear-disruption", disruptionId: "acceptance:source-closure", releaseReference: "explicit-test-technical-release:acceptance" },
      { type: "dispatch", requests: [{ trainId: f.access.trainRunId,
        interlockingRouteId: f.initialization.trains[0]!.dispatchInterlockingRouteId,
        committedRank: 0, timetableDeviationMs: 0, passengerImpact: 0, contractualImpact: 0, networkImpact: 0,
        resourceConsequence: 0, recoveryRank: 0, waitingSinceMs: f.clock.nowMs }] },
    ];
    const baselineApply = async (operation: OperationalSimulationCommandPayload) => {
      const next = await f.native.operational.apply(baseline.state, { schemaVersion: OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
        worldId: f.access.worldId, regionId: f.initialization.regionId, commandId: `acceptance:baseline:${++serial}`,
        expectedStateHash: baseline.stateHash, expectedRevision: baseline.state.revision,
        expectedPublisherSequence: baseline.state.publisherSequence, command: operation });
      baseline = next; return next;
    };
    for (const operation of resume) { await f.apply(`acceptance:resume:${++serial}`, operation); await baselineApply(operation); }
    const baselineEnd = await baselineApply({ type: "advance-to", atMs: f.settlementReadyAtMs });
    const baselineOutcome = JSON.parse(String(baselineEnd.events.find((event) => event["kind"] === "train-outcome")!["detail"]));
    expect(baselineOutcome.delaySeconds).toBeLessThanOrEqual(300);
    const pinnedTarget = (controlRecord(f.initialization.trains[0]!.stopPlan)["stops"] as unknown[]).map(controlRecord)
      .find((row) => row["stopId"] === middleStopId)!;
    const earliestActivationMs = Number(pinnedTarget["scheduledDepartureMs"]);
    expect(Number.isSafeInteger(earliestActivationMs)).toBe(true);
    expect(earliestActivationMs).toBeGreaterThan(f.clock.nowMs);
    // Vor der nativ gepinnten Zielabfahrt kann noch kein Zusatzhalt aktiv sein.
    // Der echte Advance verarbeitet auch kurze Bewegungssegmente intern;
    // weder eine Istankunft noch ein Polizeiergebnis werden dabei gesetzt.
    await advance(earliestActivationMs, false);
    const steps = [];
    let history = await f.sessions.report(f.access);
    for (let count = 0; count < 20 && controlRecord(controlRecord(history.control)["hold"])["status"] !== "released"; count++) {
      const next = await f.nextAcceptanceWakeup();
      expect(next.atMs).not.toBeNull(); expect(next.atMs!).toBeGreaterThanOrEqual(f.clock.nowMs);
      steps.push(next);
      // Auch ein jetzt fälliger nativer Betriebsereigniseintrag braucht seinen
      // tatsächlichen Advance-Commit; der Kontrollscheduler verarbeitet ihn nicht.
      await advance(next.atMs!, false);
      history = await f.sessions.report(f.access);
    }
    expect(controlRecord(controlRecord(history.control)["hold"]), JSON.stringify(steps)).toMatchObject({ status: "released", outcome: "identity_confirmed" });
    expect(steps.some((row) => row.candidates.some((candidate) => candidate.atMs === row.atMs && candidate.cause === "native-police-response-due"))).toBe(true);
    f.clock.nowMs = f.settlementReadyAtMs;
    await f.apply("acceptance:actual-day-end", { type: "advance-to", atMs: f.clock.nowMs });
    const result = await f.settleAcceptanceContract();
    expect(Number(result.outcome["delaySeconds"])).toBeGreaterThan(300);
    expect(Number(result.outcome["actualArrivalMs"])).toBeGreaterThan(baselineOutcome.actualArrivalMs);
    expect(result.outcome["distanceMm"]).toBe(baselineOutcome.distanceMm);
    expect(result.contractRevenue.penaltyCents).toBe("9000");
    expect(result.contractRevenue.orderingFeeCents).toBe("10000");
    expect(result.cashDeltaCents).toBe("1000");
    expect(result.ledgerBalanced).toBe(true);
    expect(await f.settleAcceptanceContract()).toEqual(result);
    const reportPath = process.env["ZUGFOLGE_ACCEPTANCE_COMPONENT_REPORT_PATH"];
    if (reportPath !== undefined) writeFileSync(reportPath, JSON.stringify({ schemaVersion: "conductor-acceptance-components-proof/v1",
      testOnly: true, source: f.acceptanceSource, settlementReadyAtMs: f.settlementReadyAtMs,
      sessionId: start.sessionId, originalCandidates: selected, policeCandidate: police, nativeSteps: steps, policeHistory: history,
      comparison: { sameSourceClosureAndRelease: true, baselineStartStateHash, baselineOutcome },
      pinnedTargetDepartureMs: earliestActivationMs, settlement: result }, null, 2) + "\n");
  } finally { await f.dispose(); }
}, 180_000);

nativeIt("liest die terminale Aktivierung aus dem tatsächlichen Polizeihaltkalender", async () => {
  const f = await createConductorAcceptanceNativeFixture();
  try {
    const context = await f.controlContext();
    const stops = (context.projectionInput.service["stops"] as unknown[]).map(controlRecord);
    f.clock.nowMs = Number(stops[1]!["departureMs"]);
    await f.apply("terminal:after-middle", { type: "advance-to", atMs: f.clock.nowMs });
    await f.apply("terminal:request", { type: "request-fare-control-hold", request: {
      trainId: f.access.trainRunId, caseId: "explicit-terminal-calendar-component", reason: "identity_refusal", causalityId: "terminal:calendar-proof" } });
    let calendarSeen = false;
    for (let index = 0; index < 8; index++) {
      const next = await f.nextAcceptanceWakeup();
      expect(next.atMs).not.toBeNull(); expect(next.atMs!).toBeGreaterThan(f.clock.nowMs);
      calendarSeen ||= next.candidates.some((row) => row.atMs === next.atMs && row.cause === "operational-police-calendar");
      f.clock.nowMs = next.atMs!;
      const result = await f.apply(`terminal:event:${index}`, { type: "advance-to", atMs: f.clock.nowMs });
      const hold = controlRecord(controlRecord(controlRecord(result.state.world["fareControlState"])["holds"])[f.access.trainRunId]);
      expect(hold["targetStopId"]).toBe(stops.at(-1)!["stopId"]);
      if (hold["activatedAtMs"] !== null) {
        expect(calendarSeen).toBe(true);
        expect(hold["activatedAtMs"]).toBe(f.acceptanceSource.terminalArrivalMs);
        return;
      }
    }
    throw new Error("Der tatsächliche terminale Polizeihalt wurde nicht aktiviert.");
  } finally { await f.dispose(); }
}, 90_000);
