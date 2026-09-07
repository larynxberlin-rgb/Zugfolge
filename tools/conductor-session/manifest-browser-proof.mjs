import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";
import { DemandStore } from "../../apps/game-api/dist/demand-store.js";
import { startConductorSessionBrowserBackend } from "./native-backend.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const keys = (people) => people.map((person) => person.passengerKey).sort();
const position = ({ vehicleId, bodyId, deckId, placeId, spaceId, xMm, yMm }) => ({ vehicleId, bodyId, deckId, placeId, spaceId, xMm, yMm });

// Der bestehende Fachvertrag trennt das Ankunftsbild mit Aussteigern von der
// Belegung nach quittierter Abfahrt. Alle Daten kommen aus Originalproduzenten;
// dieser Browsernachweis erzeugt keine Nachfrage oder Fahrgastkoordinaten.
test("echter Browser folgt M10-Manifesten über Störung, drei Halte und Fahrtende", {
  skip: process.env.CONDUCTOR_MANIFEST_BROWSER_TEST !== "1", timeout: 600_000,
}, async () => {
  const backend = await startConductorSessionBrowserBackend();
  const fixture = backend.fixture, { worldId, trainRunId } = fixture.access;
  const store = new DemandStore(fixture.db, fixture.native.demand);
  const output = resolve(process.env.CONDUCTOR_SESSION_SCREENSHOT_DIR ?? resolve(ROOT, "outputs/M15-Sitzung/screenshots"));
  const reportPath = resolve(process.env.CONDUCTOR_MANIFEST_REPORT_PATH ?? resolve(output, "../manifest-browser-report.json"));
  await mkdir(output, { recursive: true }); await mkdir(dirname(reportPath), { recursive: true });
  let browser, page, sequence = 0;
  const screenshots = [], pageErrors = [], captures = [], commands = [], transitions = [];
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : process.platform === "win32" ? { channel: "msedge" } : {}) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(45_000); page.on("pageerror", (error) => pageErrors.push(error.message));
    const endpoint = `${new URL(backend.url).origin}${backend.route}`;
    const headers = { authorization: `Bearer ${backend.token}` };
    const snapshot = async () => {
      const response = await page.request.get(`${endpoint}/snapshot`, { headers });
      const text = await response.text(); assert.equal(response.status(), 200, text);
      assert.doesNotMatch(text, /fareFact|journeyChainId|ownerRef|keycloakSubject/u);
      return JSON.parse(text);
    };
    const checkpoint = async () => {
      const value = await store.latest(worldId); assert.ok(value);
      assert.equal(value.result.projectionMode, "progress_bound");
      return value;
    };
    const operational = async () => {
      const result = await fixture.client.query("select state, state_hash, revision, initialization_hash from regional_simulation_states where world_id=$1 and region_id=$2", [worldId, fixture.initialization.regionId]);
      assert.equal(result.rows.length, 1); const row = result.rows[0];
      const pin = fixture.dependencies.regionBindings(worldId).find((item) => item.regionId === fixture.initialization.regionId);
      assert.equal(row.initialization_hash, pin.initializationHash);
      const restored = fixture.native.operational.restore(row.state, pin.initializationHash);
      assert.equal(restored.stateHash, row.state_hash); assert.equal(restored.state.revision, Number(row.revision));
      return restored.state;
    };
    const capture = async (name, response = undefined) => {
      const value = response ?? await snapshot(), demand = await checkpoint();
      const projection = value.snapshot.passengers, people = projection.passengers;
      const expected = keys(people);
      await page.waitForFunction(({ expected, status }) => {
        const actual = [...document.querySelectorAll(".conductor-passenger")].map((element) => element.dataset.conductorFocus?.slice("passenger:".length)).sort();
        return JSON.stringify(actual) === JSON.stringify(expected)
          && Number(document.querySelector("canvas")?.dataset.logicalPassengers) === expected.length
          && (status !== "ended" || document.querySelector(".conductor-status")?.textContent.includes("ist beendet"));
      }, { expected, status: value.snapshot.status });
      const visible = Number(await page.locator("canvas").getAttribute("data-visible-passengers"));
      assert.ok(visible >= 0 && visible <= people.length);
      assert.equal(await page.locator("canvas").getAttribute("data-renderer"), "webgl");
      if (value.snapshot.status !== "ended") {
        const manifest = demand.result.manifests.find((item) => item.trainRunId === trainRunId && item.segmentId === projection.segmentId);
        assert.ok(manifest); assert.deepEqual(expected, keys(manifest.passengers));
        assert.equal(value.snapshot.pins.manifestRevision, demand.result.revision);
      }
      const file = `manifest-${name}.png`, bytes = await page.screenshot({ path: resolve(output, file), fullPage: true });
      screenshots.push({ file, sha256: sha(bytes), viewport: page.viewportSize() });
      captures.push({ name, nowMs: fixture.clock.nowMs, status: value.snapshot.status,
        snapshotHash: value.snapshot.snapshotHash, demandStateHash: demand.result.stateHash,
        demandInputHash: demand.inputHash, progressCursorHash: demand.progressCursorHash,
        demandRevision: demand.result.revision, manifestRevision: value.snapshot.pins.manifestRevision,
        segmentId: projection.segmentId, phase: projection.phase, currentStopId: projection.currentStopId,
        logicalPassengers: people.length, listPassengers: await page.locator(".conductor-passenger").count(), visibleSprites: visible,
        onboard: people.filter((person) => person.activity === "onboard").length,
        alighting: people.filter((person) => person.activity === "alighting").length,
        passengerKeySetSha256: sha(JSON.stringify(expected)), scene: value.scene ?? null });
      console.log(`Manifestbrowser: ${name}, ${people.length} Personen, M10-Revision ${demand.result.revision}`);
      return { response: value, demand };
    };
    const command = async (payload) => {
      const id = `manifest-proof:operational:${++sequence}`;
      const result = await fixture.apply(id, payload); await fixture.refresh();
      commands.push({ commandId: id, command: payload, stateHash: result.state.stateHash, revision: result.state.revision });
    };
    const renew = async () => {
      const current = (await snapshot()).snapshot; assert.equal(current.status, "active");
      // Ein normaler, revisionsgebundener Gehauftrag zum bestätigten Ort hält
      // die Sitzung während expliziter Zeitsprünge offen. Keine Lease-Manipulation.
      const response = await page.request.post(endpoint, { headers, data: {
        schemaVersion: "conductor-command/v1", worldId, trainRunId, sessionId: current.sessionId,
        idempotencyKey: `manifest-proof:presence:${++sequence}`, expectedRevision: current.revision,
        expectedManifestRevision: current.pins.manifestRevision,
        action: { type: "move", to: current.position, transitionEdgeId: null },
      } });
      assert.equal(response.status(), 200, await response.text());
      assert.deepEqual((await response.json()).snapshot.position, current.position);
    };
    const advanceTo = async (atMs) => {
      while (fixture.clock.nowMs < atMs) {
        await renew(); await backend.advance(Math.min(300_000, atMs - fixture.clock.nowMs));
      }
    };
    const waitForReceipt = async (stopId, kind) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const demand = await checkpoint();
        if (demand.progressCursor.receipts.some((row) => row.trainRunId === trainRunId && row.stopId === stopId && row.kind === kind)) return demand;
        await advanceTo(fixture.clock.nowMs + 60_000);
      }
      assert.fail(`Kein tatsächlicher ${kind}-Beleg für ${stopId} innerhalb fünf nativer Minuten.`);
    };
    await page.goto(backend.url); await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl", null, { timeout: 90_000 });
    const initial = await capture("01-origin-full");
    assert.equal(initial.response.snapshot.passengers.passengers.length, 160);
    assert.deepEqual(initial.response.layout.capacity, { standardSeats: 104, standardStanding: 40, premiumSeats: 16, wheelchairSpaces: 2, bicycleSpaces: 12, strollerSpaces: 4 });
    const stopPlan = fixture.initialization.trains.find((train) => train.id === trainRunId).stopPlan;
    assert.equal(stopPlan.stops.length, 3);
    const [origin, middle, terminal] = stopPlan.stops;
    const firstFlow = initial.demand.result.stopFlows.find((row) => row.trainRunId === trainRunId && row.stopId === origin.stopId);
    assert.deepEqual({ boarding: firstFlow.boarding, alighting: firstFlow.alighting, onboardAfter: firstFlow.onboardAfter }, { boarding: 160, alighting: 0, onboardAfter: 160 });

    await command({ type: "activate-disruption", disruptionId: "manifest-proof:resource-closure", effect: { "resource-closed": { resourceId: "block:stop:2" } } });
    await backend.advance(1000);
    const stopped = await capture("02-native-disruption");
    assert.equal(stopped.response.scene.motionState, "safe-stop"); assert.equal(stopped.response.scene.waitingReason, "infrastructure-disruption");
    assert.deepEqual(stopped.response.snapshot.passengers.passengers, initial.response.snapshot.passengers.passengers);
    await command({ type: "clear-disruption", disruptionId: "manifest-proof:resource-closure", releaseReference: "explicit-test-technical-release:manifest-proof" });
    await command({ type: "dispatch", requests: [{ trainId: trainRunId,
      interlockingRouteId: fixture.initialization.trains.find((train) => train.id === trainRunId).dispatchInterlockingRouteId,
      committedRank: 0, timetableDeviationMs: 0, passengerImpact: 0, contractualImpact: 0,
      networkImpact: 0, resourceConsequence: 0, recoveryRank: 0, waitingSinceMs: fixture.clock.nowMs }] });
    await waitForReceipt(middle.stopId, "arrival");
    const arrived = await capture("03-middle-arrival");
    assert.equal(arrived.response.snapshot.passengers.phase, "at_stop");
    assert.equal(arrived.response.snapshot.passengers.currentStopId, middle.stopId);
    const middleBefore = arrived.demand.result.stopFlows.find((row) => row.trainRunId === trainRunId && row.stopId === middle.stopId);
    assert.equal(arrived.response.snapshot.passengers.passengers.filter((person) => person.activity === "alighting").length, middleBefore.alighting);
    assert.equal(arrived.response.snapshot.passengers.passengers.length, firstFlow.onboardAfter);
    const actualArrival = arrived.demand.progressCursor.receipts.find((row) => row.trainRunId === trainRunId && row.stopId === middle.stopId && row.kind === "arrival");
    await advanceTo(Math.max(middle.scheduledDepartureMs, actualArrival.actualTimeMs + middle.minimumDwellMs) + 1);
    await waitForReceipt(middle.stopId, "departure");
    const departed = await capture("04-middle-departure");
    const flow = departed.demand.result.stopFlows.find((row) => row.trainRunId === trainRunId && row.stopId === middle.stopId);
    const before = new Map(initial.response.snapshot.passengers.passengers.map((person) => [person.passengerKey, person]));
    const after = new Map(departed.response.snapshot.passengers.passengers.map((person) => [person.passengerKey, person]));
    const remaining = [...before.keys()].filter((key) => after.has(key));
    const left = [...before.keys()].filter((key) => !after.has(key)), boarded = [...after.keys()].filter((key) => !before.has(key));
    assert.ok(remaining.length > 0); assert.ok(left.length > 0); assert.ok(boarded.length > 0);
    assert.equal(left.length, flow.alighting); assert.equal(boarded.length, flow.boarding);
    assert.equal(after.size, before.size - flow.alighting + flow.boarding); assert.equal(after.size, flow.onboardAfter);
    for (const key of remaining) assert.deepEqual(position(after.get(key)), position(before.get(key)), `Verbleibender Fahrgast ${key} wurde versetzt.`);
    assert.notEqual(initial.response.snapshot.passengers.segmentId, departed.response.snapshot.passengers.segmentId);
    assert.ok(departed.demand.result.revision > initial.demand.result.revision);
    assert.ok(departed.response.snapshot.passengers.passengers.every((person) => person.activity === "onboard"));
    transitions.push({ stopId: middle.stopId, boarding: boarded.length, alighting: left.length, onboardAfter: after.size,
      remainingStableIdentities: remaining.length, remainingStablePositions: remaining.length,
      remainingKeySetSha256: sha(JSON.stringify(remaining.sort())), beforeSnapshotHash: initial.response.snapshot.snapshotHash, afterSnapshotHash: departed.response.snapshot.snapshotHash });

    await waitForReceipt(terminal.stopId, "arrival");
    const ended = await capture("05-terminal-ended");
    assert.equal(ended.response.snapshot.status, "ended");
    const finalResponse = await snapshot(); assert.equal(finalResponse.snapshot.status, "ended"); assert.equal(finalResponse.scene, null);
    assert.equal(await page.getByRole("button", { name: "Gehen →", exact: true }).isDisabled(), true);
    const finalFlow = ended.demand.result.stopFlows.find((row) => row.trainRunId === trainRunId && row.stopId === terminal.stopId);
    assert.equal(finalFlow.alighting, after.size); assert.equal(finalFlow.boarding, 0); assert.equal(finalFlow.onboardAfter, 0);
    const restored = await operational();
    const journal = await fixture.client.query("select sequence, event_type, payload from domain_events where world_id=$1 and event_type in ('operations.passenger-stop-arrival','operations.passenger-stop-departure') order by sequence", [worldId]);
    const receipts = ended.demand.progressCursor.receipts.filter((row) => row.trainRunId === trainRunId);
    assert.equal(receipts.length, 5);
    for (const receipt of receipts) {
      const event = journal.rows.find((row) => row.payload.receiptId === receipt.receiptId); assert.ok(event);
      assert.deepEqual(JSON.parse(event.payload.detail), receipt);
      const native = restored.world.trains[trainRunId].passengerStops;
      assert.equal(native.planHash, receipt.stopPlanHash);
      assert.equal(native.plan.stops[receipt.stopSequence].stopId, receipt.stopId);
      assert.equal(native.receipts[receipt.stopSequence][receipt.kind === "arrival" ? "actualArrivalMs" : "actualDepartureMs"], receipt.actualTimeMs);
    }
    assert.deepEqual(pageErrors, []);
    const report = { schemaVersion: "conductor-manifest-browser-proof/v1", browser: browser.version(), evidence: backend.evidence,
      fullPassengerCount: 160, capacity: initial.response.layout.capacity, layoutHash: initial.response.layout.layoutHash,
      captures, transitions, commands, stopFlows: ended.demand.result.stopFlows.filter((row) => row.trainRunId === trainRunId),
      journal: receipts.map((receipt) => ({ worldSequence: Number(journal.rows.find((row) => row.payload.receiptId === receipt.receiptId).sequence), receipt })),
      finalOperationalStateHash: restored.stateHash, finalDemandStateHash: ended.demand.result.stateHash,
      completedSession: { status: finalResponse.snapshot.status, snapshotHash: finalResponse.snapshot.snapshotHash, laterScene: finalResponse.scene },
      screenshots, pageErrors, limits: ["Explizit fiktive Originalinfrastruktur und M5-Spielkonfiguration; temporäre Testsignaturen, keine produktive Weltaktivierung.",
        "Liste und Canvasmodell enthalten alle projizierten Personen. Die ausgewählte Wagenansicht blendet ausschließlich außerhalb liegende Sprites aus.",
        "Das Ankunftsbild zeigt Aussteiger bis zur Abfahrt. Der beendete Snapshot bleibt ein eingefrorener letzter Stand; die spätere Szene ist null.",
        "Die Störung ist ein echtes privilegiertes Betriebsprüfkommando. Anwesenheitsbefehle nutzen die unveränderte authentifizierte Sitzungs-API."] };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ reportPath, screenshots: screenshots.length, receipts: receipts.length, transitions }));
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(output, "manifest-failure.png"), fullPage: true }).catch(() => {});
    await writeFile(resolve(dirname(reportPath), "manifest-failure.json"), `${JSON.stringify({ message: error.message, nowMs: fixture.clock.nowMs, captures, commands, pageErrors }, null, 2)}\n`);
    throw error;
  } finally { await browser?.close(); await backend.close(); }
});
