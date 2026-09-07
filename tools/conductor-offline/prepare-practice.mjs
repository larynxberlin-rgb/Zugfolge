// Explizite Übungsquellen. Keine Änderung einzelner M10-Personen oder Platzzuordnungen.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { loadOfflineKernel } from "./src/wasm-loader.ts";

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const save = async (path, value) => writeFile(new URL(path, import.meta.url), JSON.stringify(value, null, 2) + "\n");
const fixture = await read("./data/fixture.json");
const kernel = await loadOfflineKernel(new Uint8Array(await readFile(new URL("./native/kernel.wasm", import.meta.url))));
const invoke = kernel.invoke;
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const retained = { interior: sha(fixture.source.interior), infrastructure: sha(fixture.infrastructure),
  operationalWorld: sha(fixture.source.operationalWorld), service: sha(fixture.source.projection.service),
  dialogue: sha(fixture.source.dialogueReleases), economy: sha(fixture.control.economyRelease) };

// The M5 formation, all seats, decks and native route/stop receipts stay intact.
// Population and compliance are global, openly fictional learning parameters.
const demand = structuredClone(fixture.demand);
demand.release.id = "offline-control-practice-v1";
demand.release.zones.forEach((zone) => { zone.population = zone.id === "leipzig" ? 48 : 8; });
demand.release.fareCompliance = { ...demand.release.fareCompliance,
  validBasisPoints: 3500, unpresentableBasisPoints: 3000, provenance: "balanced", sourceIds: [] };
fixture.control.inspectionPolicy = { ...fixture.control.inspectionPolicy, policyId: "offline-practice-inspection-v1",
  invalidDocumentPresentedBasisPoints: 10000, identityRefusalBasisPoints: 1500, concreteDangerBasisPoints: 0, contentHash: "" };
fixture.control.inspectionPolicy.contentHash = await invoke("fare.policyHash", fixture.control.inspectionPolicy);

function projection(evaluation) {
  return { ...fixture.source.projection, previousProjection: null, evaluation, binding: {
    ...fixture.source.projection.binding, demandReleaseId: evaluation.demandReleaseId,
    releaseHash: evaluation.releaseHash, seedHash: evaluation.seedHash, manifestRevision: evaluation.revision,
    demandStateHash: evaluation.stateHash, operationalReceiptId: evaluation.operationalProgress.receiptId,
  } };
}
async function start(candidateFixture) {
  let result = await invoke("offline.initialize", { fixture: candidateFixture });
  result = await invoke("offline.command", { fixture: candidateFixture, checkpoint: result.checkpoint, elapsedMs: 0,
    command: { schemaVersion: "conductor-command/v1", worldId: result.context.worldId, trainRunId: result.context.trainRunId,
      sessionId: randomUUID(), expectedRevision: result.availability.revision, expectedManifestRevision: null,
      idempotencyKey: randomUUID(), action: { type: "start_session" } } });
  return result;
}
async function evidence(result, person, manifest) {
  const pin = { worldId: result.context.worldId, operatorId: result.context.operatorId, periodId: demand.periodId,
    trainRunId: result.context.trainRunId, encounterId: "practice-selection-only", manifestRevision: result.availability.manifestRevision,
    demandStateHash: result.checkpoint.source.projection.binding.demandStateHash, segmentId: manifest.segmentId, passenger: person,
    dialogueReleaseHash: result.response.snapshot.pins.dialogueReleaseHash, inspectedAtMs: result.response.snapshot.nowMs,
    seedHash: result.checkpoint.source.projection.binding.seedHash, inspectionPolicy: fixture.control.inspectionPolicy,
    journeyEvidence: fixture.control.journeys.find((row) => row.trainRunId === manifest.trainRunId
      && row.boardingStopId === person.boardingStopId && row.alightingStopId === person.alightingStopId) ?? null,
    economyRelease: fixture.control.economyRelease, expectedEconomyReleaseHash: fixture.control.economyRelease.checksum };
  let state = await invoke("fare.initialize", { worldId: result.context.worldId, operatorId: result.context.operatorId, nowMs: pin.inspectedAtMs });
  for (const action of [{ type: "open_case", caseId: "selection", pin }, { type: "inspect_document", caseId: "selection" }]) {
    ({ state } = await invoke("fare.apply", { state, expectedStateHash: state.stateHash, command: {
      worldId: result.context.worldId, operatorId: result.context.operatorId, commandId: randomUUID(),
      expectedRevision: state.revision, nowMs: pin.inspectedAtMs, action } }));
  }
  return state.cases.selection.evidence;
}

let accepted;
const firstSeed = Number(process.argv[2] ?? "0");
assert.ok(Number.isSafeInteger(firstSeed) && firstSeed >= 0);
for (let seed = firstSeed; seed < firstSeed + 200; seed++) {
  demand.seed = String(seed);
  const forecast = await invoke("demand.evaluate", { ...demand, nowMs: 0, revision: 1,
    previousEvaluation: null, operationalProgress: null });
  demand.previousEvaluation = { result: forecast, services: structuredClone(demand.services) };
  demand.revision = 2;
  const evaluation = await invoke("demand.evaluate", demand);
  const journeys = new Map();
  for (const manifest of evaluation.manifests) for (const passenger of manifest.passengers) {
    const key = `${manifest.trainRunId}:${passenger.boardingStopId}:${passenger.alightingStopId}`;
    if (journeys.has(key)) continue;
    const journey = { schemaVersion: "fare-journey-evidence/v1", evidenceId: `offline-practice:${key}`,
      worldId: demand.worldId, periodId: demand.periodId, trainRunId: manifest.trainRunId,
      boardingStopId: passenger.boardingStopId, alightingStopId: passenger.alightingStopId,
      ordinaryFareCents: "1250", ticketOffice: "available", ticketMachine: "unknown",
      sourceId: "explicit-fictional-game-tariff-not-real-world-fare", contentHash: "" };
    journey.contentHash = await invoke("fare.journeyHash", journey); journeys.set(key, journey);
  }
  fixture.control.journeys = [...journeys.values()];
  const candidateFixture = { ...fixture, demand: structuredClone(demand), source: {
    ...fixture.source, projection: projection(evaluation) } };
  const result = await start(candidateFixture);
  const snapshot = result.response.snapshot, layout = result.response.layout;
  const manifest = evaluation.manifests.find((row) => row.trainRunId === snapshot.trainRunId && row.segmentId === snapshot.passengers.segmentId);
  const rows = snapshot.passengers.passengers.filter((person) => person.activity === "onboard");
  assert.ok(rows.length >= 18 && rows.length <= 45, `Training demand is ${rows.length}, expected 18..45`);
  const startPoint = snapshot.position;
  const nearby = rows.filter((person) => person.vehicleId === startPoint.vehicleId && person.bodyId === startPoint.bodyId).map((visible) => {
    const person = manifest.passengers.find((person) => person.passengerKey === visible.passengerKey);
    const interaction = layout.interactions.find((interaction) => interaction.targetId === (visible.spaceNeeds === "wheelchair" ? visible.spaceId : visible.placeId));
    return { visible, person, interaction, estimatedDistance: Math.abs(visible.xMm - startPoint.xMm) + Math.abs(visible.yMm - startPoint.yMm) };
  }).filter((row) => row.person && row.interaction).sort((a, b) => a.estimatedDistance - b.estimatedDistance);
  const selected = new Map();
  for (const row of nearby) {
    if (selected.has(row.person.fareFact)) continue;
    const hints = await evidence(result, row.person, manifest);
    if (row.person.fareFact !== "valid" && (hints.identityStatus !== "confirmed" || hints.acquisitionException !== "excluded")) continue;
    const path = await invoke("offline.path", { fixture: candidateFixture, checkpoint: result.checkpoint, targetNodeId: row.interaction.nodeId });
    let from = path.from, pathLengthMm = 0;
    for (const point of path.points) {
      assert.equal(point.to.bodyId, startPoint.bodyId);
      if (point.transitionEdgeId !== null) {
        const edge = layout.edges.find((edge) => edge.edgeId === point.transitionEdgeId);
        assert.ok(edge && Number.isSafeInteger(edge.lengthMm)); pathLengthMm += edge.lengthMm;
      } else pathLengthMm += Math.abs(point.to.xMm - from.xMm) + Math.abs(point.to.yMm - from.yMm);
      from = point.to;
    }
    if (pathLengthMm > 12_000) continue;
    selected.set(row.person.fareFact, { passengerKey: row.visible.passengerKey, placeId: row.visible.placeId,
      targetNodeId: row.interaction.nodeId, position: { vehicleId: row.visible.vehicleId, bodyId: row.visible.bodyId,
        deckId: row.visible.deckId, xMm: row.visible.xMm, yMm: row.visible.yMm }, pathLengthMm,
      expectedFareFact: row.person.fareFact, expectedEvidence: hints });
  }
  if (["valid", "invalid", "valid_unpresentable"].every((key) => selected.has(key))) {
    accepted = { fixture: candidateFixture, result, selected, seed, passengers: rows.length }; break;
  }
  if (seed % 10 === 0) process.stdout.write(JSON.stringify({ selectionOnly: true, seed, passengers: rows.length, nearby: nearby.length, matched: [...selected.keys()] }) + "\n");
}
assert.ok(accepted, "No three genuine nearby practice cases found; fixture remains unchanged.");
const finalFixture = accepted.fixture;
assert.deepEqual({ interior: sha(finalFixture.source.interior), infrastructure: sha(finalFixture.infrastructure),
  operationalWorld: sha(finalFixture.source.operationalWorld), service: sha(finalFixture.source.projection.service),
  dialogue: sha(finalFixture.source.dialogueReleases), economy: sha(finalFixture.control.economyRelease) }, retained);
const targets = ["valid", "invalid", "valid_unpresentable"].map((kind, index) => ({
  label: `Übung ${index + 1}`, ...accepted.selected.get(kind),
}));
await save("./data/control-provenance.json", { schemaVersion: "offline-control-configuration/v1", testOnly: true,
  source: "prepare-practice.mjs; original M10/fare-control WASM functions",
  fixtureHash: accepted.result.context.fixtureHash, ordinaryFareCents: "1250",
  inspectionPolicy: finalFixture.control.inspectionPolicy, policeResponseModel: finalFixture.control.policeResponseModel,
  economyReleaseHash: finalFixture.control.economyRelease.checksum, journeyCount: finalFixture.control.journeys.length,
  reason: "Global fictional learning quotas and complete explicit practice tariffs; no individual passenger or place edits." });
// Public file contains only original visible identities/coordinates and neutral
// labels. Expected outcomes stay in the separate, unbundled QA document.
await save("./data/practice-public.json", { schemaVersion: "conductor-offline-practice/v1", testOnly: true,
  fixtureHash: accepted.result.context.fixtureHash, passengers: accepted.passengers,
  targets: targets.map(({ label, passengerKey, position }) => ({ label, passengerKey, position })) });
await save("./data/practice-qa.json", { schemaVersion: "conductor-offline-practice-qa/v1", testOnly: true,
  selectionProbesAreNotControls: true, browserAcceptance: "pending", kernelSha256: kernel.kernelSha256,
  fixtureHash: accepted.result.context.fixtureHash, seed: String(accepted.seed), passengers: accepted.passengers,
  formationCapacity: finalFixture.source.projection.interior.places.length, retainedSourceHashes: retained,
  globalLearningCompliance: demand.release.fareCompliance, inspectionPolicy: fixture.control.inspectionPolicy,
  actualStopProgress: finalFixture.demand.operationalProgress, targets });
await writeFile(new URL("./data/fixture.json", import.meta.url), JSON.stringify(finalFixture));
process.stdout.write(JSON.stringify({ prepared: true, testOnly: true, seed: accepted.seed,
  passengers: accepted.passengers, pathsMm: targets.map((target) => target.pathLengthMm), fixtureHash: accepted.result.context.fixtureHash }) + "\n");
