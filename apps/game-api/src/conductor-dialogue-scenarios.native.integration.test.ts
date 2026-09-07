import { expect, it } from "vitest";
import Fastify from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { conductorTrainStates } from "@zugfolge/db";
import { and, eq } from "drizzle-orm";
import type { ConductorCommandActionV1, ConductorCommandV1, InteriorPointV1 } from "@zugfolge/runtime-native";
import { createFareControlNativeFixture, hasFareControlNative } from "./conductor-control.native-fixture.js";
import { ConductorSessionService, type ConductorSessionResponse } from "./conductor-session-service.js";
import { registerConductorSessionRoutes } from "./conductor-session-routes.js";
import { controlRecord } from "./conductor-control-runtime.js";

const DEMAND_SEED = "138";
const nativeIt = hasFareControlNative ? it : it.skip;
nativeIt("führt sechs ursprüngliche Dialogsituationen in einer echten M10-Fahrt über HTTP aus", async () => {
  const f = await createFareControlNativeFixture({ invalidDocumentPresentedBasisPoints: 10_000, demandSeed: DEMAND_SEED });
  const app = Fastify();
  let sessions = f.sessions;
  const base = `/worlds/${f.access.worldId}/operators/${f.access.operatorId}/trains/${f.access.trainRunId}/conductor-sessions`;
  try {
    app.decorateRequest("identity", null);
    registerConductorSessionRoutes(app, { get conductorSessions() { return sessions; }, async authenticate(request) {
      request.identity = { keycloakSubject: f.access.keycloakSubject, displayName: "Fiktiver Dialogtest" };
    } });
    let serial = 0, response: ConductorSessionResponse;
    const sessionId = "original-six-dialogues";
    const privacy = (body: string) => {
      expect(body.match(/"fareFact"|"inspectionPolicy"|"ownerRef"|"selectionHash"|"treeId"/u)?.[0]).toBeUndefined();
      expect(JSON.stringify(JSON.parse(body).control).match(/"passengerKey"|"seedHash"|"responseAfterActivation"|"identityConfirmed"/u)?.[0]).toBeUndefined();
    };
    const snapshot = async () => {
      const result = await app.inject({ method: "GET", url: `${base}/snapshot` });
      expect(result.statusCode, result.body).toBe(200); privacy(result.body);
      response = result.json<ConductorSessionResponse>(); return response;
    };
    const command = async (action: ConductorCommandActionV1, replay = false) => {
      const input: ConductorCommandV1 = { schemaVersion: "conductor-command/v1", worldId: f.access.worldId,
        trainRunId: f.access.trainRunId, sessionId, expectedRevision: response?.snapshot.revision ?? 0,
        expectedManifestRevision: response?.snapshot.pins.manifestRevision ?? null, idempotencyKey: `original-dialogue:${++serial}`, action };
      const result = await app.inject({ method: "POST", url: base, payload: input });
      expect(result.statusCode, result.body).toBe(200); privacy(result.body);
      response = result.json<ConductorSessionResponse>();
      if (replay) {
        const again = await app.inject({ method: "POST", url: base, payload: input });
        expect(again.statusCode, again.body).toBe(200);
        expect(again.json().receipt).toEqual(response.receipt);
        expect(again.json().snapshot.activeEncounter).toEqual(response.snapshot.activeEncounter);
      }
      return response;
    };
    const advance = async (ms: number) => {
      f.clock.nowMs += ms;
      await f.apply(`original-dialogue:time:${++serial}`, { type: "advance-to", atMs: f.clock.nowMs });
      await f.refresh(); await snapshot();
    };
    await command({ type: "start_session" });
    const initial = response!;
    const context = await f.controlContext();
    const release = f.dependencies.sessionReleases.resolve(f.access.worldId, context.period.periodId)!;
    const sourceTrees = (controlRecord(release.dialogueReleases[0])["families"] as unknown[]).map(controlRecord)
      .flatMap((row) => (row["trees"] as unknown[]).map(controlRecord));
    const terminalStopId = String(controlRecord((context.projectionInput.service["stops"] as unknown[]).at(-1))["stopId"]);
    const candidates = (await f.originalDialogueCandidates()).filter((row) => row.alightingStopId === terminalStopId);
    type Candidate = typeof candidates[number];
    const phone = (row: Candidate) => ["empty_phone", "defective_phone", "technical_issue"].includes(row.presentation);
    const plans = [
      { id: "friendly-admission", matches: (row: Candidate) => row.presentation === "admission" && row.tone === "friendly" && row.fareFact === "invalid", options: ["check", "regular"] },
      { id: "actual-phone-problem", matches: (row: Candidate) => phone(row) && row.fareFact === "valid_unpresentable", options: ["ask", "check", "provisional"] },
      { id: "false-phone-problem", matches: (row: Candidate) => phone(row) && row.fareFact === "invalid", options: ["check", "regular"] },
      { id: "unfriendly-reaction", matches: (row: Candidate) => row.presentation === "hostile_reaction" && row.tone === "unfriendly" && row.fareFact === "valid", options: ["ask", "check", "close"] },
      { id: "cooperative-intoxication", matches: (row: Candidate) => row.presentation === "intoxication" && row.cooperation === "cooperative" && row.fareFact === "valid", options: ["check", "explain", "close"] },
      { id: "refusal", matches: (row: Candidate) => row.presentation === "refusal" && row.fareFact === "valid", options: ["ask", "check", "close"] },
    ];
    const cases = [], used = new Set<string>();
    const samePoint = (a: InteriorPointV1, b: InteriorPointV1) => a.vehicleId === b.vehicleId && a.bodyId === b.bodyId
      && a.deckId === b.deckId && a.xMm === b.xMm && a.yMm === b.yMm;
    for (const plan of plans) {
      const from = response!.layout.nodes.find((row) => samePoint(row.point, response!.snapshot.position))!;
      const choices = candidates.filter((row) => plan.matches(row) && !used.has(row.passengerKey)).map((candidate) => {
        const passenger = response!.snapshot.passengers.passengers.find((row) => row.passengerKey === candidate.passengerKey && row.activity === "onboard")!;
        const targetId = passenger.spaceNeeds === "wheelchair" ? passenger.spaceId : passenger.placeId;
        const target = response!.layout.interactions.find((row) => row.targetId === targetId)!;
        const path = f.runtimes.interior.path({ schemaVersion: "conductor-interior-path-input/v1", layout: response!.layout,
          expectedLayoutHash: response!.layout.layoutHash, fromNodeId: from.nodeId, toNodeId: target.nodeId, wheelchair: false });
        return { candidate, path };
      }).sort((a, b) => a.path.lengthMm - b.path.lengthMm || a.candidate.passengerKey.localeCompare(b.candidate.passengerKey));
      expect(choices.length, `Fehlende Originalkombination ${plan.id} für Testseed ${DEMAND_SEED}`).toBeGreaterThan(0);
      const selected = choices[0]!, policy = release.policy;
      // Nur kollineare Stücke desselben tatsächlichen Kernwegs zusammenfassen.
      for (let index = 1; index < selected.path.nodeIds.length;) {
        let last = index;
        const origin = response!.snapshot.position;
        const first = response!.layout.edges.find((row) => row.edgeId === selected.path.edgeIds[index - 1])!;
        let length = first.lengthMm;
        if (first.kind === "walk") {
          for (let next = index + 1; next < selected.path.nodeIds.length; next++) {
            const edge = response!.layout.edges.find((row) => row.edgeId === selected.path.edgeIds[next - 1])!;
            const point = response!.layout.nodes.find((row) => row.nodeId === selected.path.nodeIds[next])!.point;
            if (edge.kind !== "walk" || point.vehicleId !== origin.vehicleId || point.bodyId !== origin.bodyId || point.deckId !== origin.deckId
              || point.xMm !== origin.xMm && point.yMm !== origin.yMm || length + edge.lengthMm > policy.maxMovementBurstMm) break;
            length += edge.lengthMm; last = next;
          }
        }
        const target = response!.layout.nodes.find((row) => row.nodeId === selected.path.nodeIds[last])!.point;
        await advance(Math.max(1000, Math.ceil(length * 1000 / policy.walkSpeedMmPerSecond)));
        await command({ type: "move", to: target, transitionEdgeId: first.kind === "walk" ? null : first.edgeId });
        expect(response!.snapshot.position).toEqual(target); index = last + 1;
      }
      await command({ type: "start_inspection", passengerKey: selected.candidate.passengerKey });
      used.add(selected.candidate.passengerKey);
      expect(response!.snapshot.sessionId).toBe(sessionId);
      expect(response!.snapshot.activeEncounter!.passengerText).toBe(selected.candidate.passengerText);
      expect(response!.snapshot.activeEncounter!.hints).toEqual({ documentStatus: "unchecked", acquisitionException: "unknown", identityStatus: "unknown", concreteDanger: false });
      expect(response!.snapshot.activeEncounter!.options.map((row) => row.optionId)).not.toContain("police");
      const tree = sourceTrees.find((row) => row["treeId"] === selected.candidate.treeId)!;
      const nodes = (tree["nodes"] as unknown[]).map(controlRecord);
      let nodeId = String(tree["entryNodeId"]);
      const utterances = [response!.snapshot.activeEncounter!.passengerText], evidence = [];
      for (const optionId of plan.options) {
        const current = response!.snapshot.activeEncounter!;
        if (current.availableAtMs > f.clock.nowMs) await advance(current.availableAtMs - f.clock.nowMs);
        const option = (nodes.find((row) => row["nodeId"] === nodeId)!["options"] as unknown[]).map(controlRecord).find((row) => row["optionId"] === optionId)!;
        expect(response!.snapshot.activeEncounter!.options.some((row) => row.optionId === optionId)).toBe(true);
        await command({ type: "choose_dialogue_option", optionId }, optionId === "check");
        nodeId = String(option["nextNodeId"]);
        if (response!.snapshot.activeEncounter !== null) {
          const expectedText = String(nodes.find((row) => row["nodeId"] === nodeId)!["passengerText"]);
          expect(response!.snapshot.activeEncounter!.passengerText).toBe(expectedText); utterances.push(expectedText);
          if (optionId === "check") {
            const hints = response!.snapshot.activeEncounter!.hints;
            expect(hints.documentStatus).toBe(selected.candidate.fareFact === "invalid" ? "verified_invalid" : selected.candidate.fareFact === "valid_unpresentable" ? "not_presentable" : "verified_valid");
            expect(hints.concreteDanger).toBe(false); evidence.push(hints);
            const beforeReload = response!.snapshot.activeEncounter;
            sessions = new ConductorSessionService({ ...f.dependencies, control: f.control });
            await snapshot(); expect(response!.snapshot.activeEncounter).toEqual(beforeReload);
          }
        }
      }
      expect(response!.snapshot.activeEncounter).toBeNull();
      const [stored] = await f.db.select().from(conductorTrainStates).where(and(eq(conductorTrainStates.worldId, f.access.worldId), eq(conductorTrainStates.trainRunId, f.access.trainRunId)));
      const restored = f.native.session.restore(stored!.state as Parameters<typeof f.native.session.restore>[0], stored!.stateHash, release.dialogueReleases);
      const record = controlRecord(Object.values(restored.encounters).find((row) => row["passengerKey"] === selected.candidate.passengerKey));
      expect(controlRecord(record["dialogue"])["treeId"]).toBe(selected.candidate.treeId);
      cases.push({ scenario: plan.id, treeId: selected.candidate.treeId, presentation: selected.candidate.presentation, tone: selected.candidate.tone,
        cooperation: selected.candidate.cooperation, utterances, evidence, options: plan.options, restoredStateHash: restored.stateHash });
      console.info(`Originaldialog bestätigt: ${plan.id} → ${selected.candidate.treeId}`);
    }
    expect(cases).toHaveLength(6); expect(used.size).toBe(6);
    await command({ type: "end_session" });
    const report = { schemaVersion: "conductor-dialogue-http-proof/v1", testOnly: true, demandSeed: DEMAND_SEED,
      worldId: f.access.worldId, trainRunId: f.access.trainRunId, sessionId, dialogueReleaseHash: release.currentDialogueReleaseHash,
      initialDemandStateHash: initial.snapshot.pins.demandStateHash, originalFareFactsUnchanged: true,
      nativeM10Producer: true, httpCommands: true, reloadAndCommandReplay: true, cases };
    const output = process.env["ZUGFOLGE_DIALOGUE_SCENARIOS_REPORT_PATH"];
    if (output !== undefined) { const path = resolve(output); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2) + "\n"); }
  } finally { await app.close(); await f.dispose(); }
}, 600_000);
