import { outputPath } from "./paths.mjs";
// Component evidence only. This does not substitute for clicking the actual UI.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadOfflineKernel } from "./src/wasm-loader.ts";
const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const fixture = await read("./data/fixture.json"), qa = await read("./data/practice-qa.json"), publicPractice = await read("./data/practice-public.json");
const kernel = await loadOfflineKernel(new Uint8Array(await readFile(new URL("./native/kernel.wasm", import.meta.url))));
let result = await kernel.invoke("offline.initialize", { fixture }), moves = 0;
assert.equal(result.context.fixtureHash, qa.fixtureHash);
assert.equal(publicPractice.fixtureHash, qa.fixtureHash);
assert.ok(!JSON.stringify(publicPractice).match(/fareFact|expected|documentStatus|claimKind|invalid|valid_unpresentable/u));
const sessionId = randomUUID(), cases = [];
async function action(action, elapsedMs = 1000) {
  const command = { schemaVersion: "conductor-command/v1", worldId: result.context.worldId, trainRunId: result.context.trainRunId,
    sessionId, expectedRevision: result.availability.revision, expectedManifestRevision: action.type === "start_session" ? null : result.availability.manifestRevision,
    idempotencyKey: randomUUID(), action };
  result = await kernel.invoke("offline.command", { fixture, checkpoint: result.checkpoint, command, elapsedMs });
  return result.response.snapshot;
}
async function tick(elapsedMs) { result = await kernel.invoke("offline.tick", { fixture, checkpoint: result.checkpoint, elapsedMs }); }
async function choose(optionId) {
  const encounter = result.response.snapshot.activeEncounter;
  assert.ok(encounter?.options.some((option) => option.optionId === optionId), `Missing actual option: ${optionId}`);
  await action({ type: "choose_dialogue_option", optionId }, Math.max(1000, encounter.availableAtMs - result.response.snapshot.nowMs));
}
await action({ type: "start_session" }, 0);
assert.equal(result.response.snapshot.passengers.passengers.length, qa.passengers);
let stairTransitions = 0;
for (const target of qa.targets) {
  assert.ok(result.response.snapshot.passengers.passengers.some((person) => person.passengerKey === target.passengerKey && person.activity === "onboard"));
  const path = await kernel.invoke("offline.path", { fixture, checkpoint: result.checkpoint, targetNodeId: target.targetNodeId });
  for (const waypoint of path.points) {
    for (let guard = 0; JSON.stringify(result.response.snapshot.position) !== JSON.stringify(waypoint.to); guard++) {
      assert.ok(guard < 100, "Native path did not finish");
      const from = result.response.snapshot.position, dx = waypoint.to.xMm - from.xMm, dy = waypoint.to.yMm - from.yMm;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      const to = waypoint.transitionEdgeId !== null || distance <= 500 ? waypoint.to
        : { ...from, xMm: from.xMm + Math.round(dx * 500 / distance), yMm: from.yMm + Math.round(dy * 500 / distance) };
      if (to.deckId !== from.deckId) stairTransitions++;
      await action({ type: "move", to, transitionEdgeId: waypoint.transitionEdgeId }); moves++;
    }
  }
  await action({ type: "start_inspection", passengerKey: target.passengerKey });
  const first = result.response.snapshot.activeEncounter;
  assert.ok(first); assert.equal(first.hints.documentStatus, "unchecked");
  assert.ok(first.options.some((option) => option.optionId === "check"));
  const encounterId = first.encounterId;
  await choose("check");
  assert.deepEqual(result.response.snapshot.activeEncounter.hints, target.expectedEvidence);
  const available = result.response.snapshot.activeEncounter.options.map((option) => option.optionId);
  const expectedOption = target.expectedFareFact === "valid" ? "close" : target.expectedFareFact === "invalid" ? "regular" : "provisional";
  if (!available.includes(expectedOption)) {
    await writeFile(outputPath("practice-control-failure.json"), JSON.stringify({
      label: target.label, expectedOption, encounter: result.response.snapshot.activeEncounter,
      nativeCase: Object.values(result.checkpoint.fare.cases).find((row) => row.pin.encounterId === encounterId),
    }, null, 2));
  }
  if (target.expectedFareFact === "valid") {
    assert.ok(!available.includes("regular") && !available.includes("provisional") && !available.includes("police"));
  }
  await choose(expectedOption);
  const opened = result.report.cases.find((row) => row.encounterId === encounterId);
  assert.ok(opened);
  if (expectedOption === "close") {
    assert.equal(opened.status, "closed_without_claim"); assert.equal(opened.claimKind, null); assert.equal(opened.claimCents, "0");
  } else {
    assert.equal(opened.claimKind, expectedOption); assert.equal(opened.claimCents, "6000");
    await tick(fixture.control.economyRelease.fareInspection.paymentDelayMs + 1);
    const paid = result.report.cases.find((row) => row.caseId === opened.caseId);
    assert.equal(paid.paidCents, "6000");
    if (expectedOption === "provisional") {
      await tick(fixture.control.economyRelease.fareInspection.validProofDelayMs + 1);
      assert.equal(result.report.cases.find((row) => row.caseId === opened.caseId).claimCents, "700");
    }
  }
  cases.push({ label: target.label, expectedFareFact: target.expectedFareFact, originalPassengerText: first.passengerText,
    actualEvidence: target.expectedEvidence, chosenOption: expectedOption, initialCase: opened,
    finalCase: result.report.cases.find((row) => row.caseId === opened.caseId) });
}
assert.ok(stairTransitions >= 1);
const restored = await kernel.invoke("offline.restore", { fixture, checkpoint: result.checkpoint });
assert.deepEqual(restored.response, result.response); assert.deepEqual(restored.report, result.report);
const report = { schemaVersion: "conductor-offline-practice-components/v1", testOnly: true,
  evidenceKind: "native-components-not-browser-acceptance", browserAcceptance: "pending",
  kernelSha256: kernel.kernelSha256, fixtureHash: result.context.fixtureHash, passengers: qa.passengers,
  nativeMoves: moves, nativeStairTransitions: stairTransitions, nativeRestoreEqual: true,
  noPublicFareFacts: true, cases };
await writeFile(outputPath("practice-control-report.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify({ passed: true, passengers: qa.passengers, nativeMoves: moves, stairTransitions,
  cases: cases.map((row) => ({ label: row.label, chosenOption: row.chosenOption, claimCents: row.finalCase.claimCents, paidCents: row.finalCase.paidCents })) }) + "\n");
