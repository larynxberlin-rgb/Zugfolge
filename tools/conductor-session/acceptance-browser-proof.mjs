import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";
import { createConductorAcceptanceNativeFixture } from "../../apps/game-api/dist/conductor-acceptance.native-fixture.js";
import { DemandStore } from "../../apps/game-api/dist/demand-store.js";
import { startConductorSessionBrowserBackend } from "./native-backend.mjs";
import { createConductorProofDriver, samePoint } from "./browser-driver.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const phone = (row) => ["empty_phone", "defective_phone", "technical_issue"].includes(row.presentation);

test("one actual browser trip connects six original dialogues, police, network, M10 and M6 ledger", {
  skip: process.env.CONDUCTOR_ACCEPTANCE_BROWSER_TEST !== "1", timeout: 2_700_000,
}, async () => {
  const backend = await startConductorSessionBrowserBackend({ fixtureFactory: () => createConductorAcceptanceNativeFixture({
    demandSeed: "167",
    sessionFixture: { networkScenario: "conductor-network-acceptance/v1" },
  }) });
  const f = backend.fixture;
  const output = resolve(process.env.CONDUCTOR_SESSION_SCREENSHOT_DIR ?? resolve(ROOT, "outputs/M15-Sitzung/screenshots"));
  const reportPath = resolve(process.env.CONDUCTOR_ACCEPTANCE_REPORT_PATH ?? resolve(output, "../acceptance-browser-report.json"));
  const cases = [], events = [], stationScenes = [], used = new Set();
  let browser, page, driver, preflight, serial = 0;
  try {
    await mkdir(output, { recursive: true });
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : process.platform === "win32" ? { channel: "msedge" } : {}) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce", hasTouch: true });
    driver = createConductorProofDriver({ backend, page, output });
    const { request, shot, idle, option, reportReady, historyRequest } = driver;
    const command = async (payload) => {
      const result = await f.apply(`acceptance-browser:operational:${++serial}`, payload);
      await f.refresh(); await f.advanceControl();
      events.push({ kind: "command", command: payload, atMs: f.clock.nowMs, stateHash: result.state.stateHash });
      return result;
    };
    await page.goto(backend.url); await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl", null, { timeout: 90000 });
    await driver.assertContext();
    const initial = await request(), sessionId = initial.snapshot.sessionId;
    if (initial.scene?.station) stationScenes.push(initial.scene);
    const store = new DemandStore(f.db, f.native.demand);
    const initialDemand = await store.latest(f.access.worldId); assert.ok(initialDemand);
    assert.equal(initialDemand.result.projectionMode, "progress_bound");
    await shot("acceptance-01-original-trip");
    await command({ type: "activate-disruption", disruptionId: "acceptance:infrastructure-closure",
      effect: { "resource-closed": { resourceId: "block:stop:2" } } });
    const stopped = await request(); assert.equal(stopped.scene.motionState, "safe-stop");
    assert.equal(stopped.scene.waitingReason, "infrastructure-disruption");
    assert.equal(stopped.scene.speedMmps, 0);
    await page.waitForTimeout(1500); await shot("acceptance-02-actual-infrastructure-stop");

    // Original scene identity and scratch inspection remain Node-only target
    // selection. Every public result below comes from actual DOM commands.
    const through = new Set(await backend.throughPassengerKeys());
    const originalOnboard = new Set(initial.snapshot.passengers.passengers.filter((row) => row.activity === "onboard").map((row) => row.passengerKey));
    const originals = (await f.originalDialogueCandidates()).filter((row) => originalOnboard.has(row.passengerKey));
    const inspections = new Map((await f.inspectionCandidates({ all: true })).map((row) => [row.passengerKey, row.evidence]));
    const actualContext = await f.controlContext();
    preflight = { testOnly: true, nodeOnly: true, source: f.acceptanceSource, atMs: f.clock.nowMs,
      originalOnboard: [...originalOnboard], binding: actualContext.projectionInput.binding,
      originals: originals.map((row) => ({ ...row, evidence: inspections.get(row.passengerKey) })) };
    const plans = [
      { id: "friendly-admission", matches: (row) => row.presentation === "admission" && row.tone === "friendly" && row.fareFact === "invalid", options: ["check", "regular"] },
      { id: "actual-phone-problem", matches: (row) => phone(row) && row.fareFact === "valid_unpresentable", options: ["ask", "check", "provisional"] },
      { id: "false-phone-problem", matches: (row) => phone(row) && row.fareFact === "invalid", options: ["check", "regular"] },
      { id: "unfriendly-reaction", matches: (row) => row.presentation === "hostile_reaction" && row.tone === "unfriendly" && row.fareFact === "valid", options: ["ask", "check", "close"] },
      { id: "cooperative-intoxication", matches: (row) => row.presentation === "intoxication" && row.cooperation === "cooperative" && row.fareFact === "valid", options: ["check", "explain", "close"] },
      { id: "refusal", matches: (row) => row.presentation === "refusal" && row.fareFact === "valid", options: ["ask", "check", "close"] },
    ];
    for (const plan of plans) assert.ok(originals.some((row) => plan.matches(row)
      && (row.fareFact === "valid" || inspections.get(row.passengerKey)?.identityStatus === "confirmed")),
    `The exact combined network corpus must contain ${plan.id}`);
    assert.ok(originals.some((row) => row.fareFact === "invalid" && through.has(row.passengerKey) && inspections.get(row.passengerKey)?.identityStatus === "refused"));
    const nearest = async (remaining) => {
      const current = await request(), from = current.layout.nodes.find((node) => samePoint(node.point, current.snapshot.position));
      assert.ok(from);
      const choices = remaining.flatMap((plan) => originals.filter((row) => plan.matches(row) && !used.has(row.passengerKey)
        && (row.fareFact === "valid" || inspections.get(row.passengerKey)?.identityStatus === (plan.id === "police" ? "refused" : "confirmed")))
        .map((candidate) => {
          const person = current.snapshot.passengers.passengers.find((row) => row.passengerKey === candidate.passengerKey && row.activity === "onboard");
          assert.ok(person);
          const target = current.layout.interactions.find((row) => row.targetId === (person.spaceNeeds === "wheelchair" ? person.spaceId : person.placeId));
          assert.ok(target);
          const path = f.runtimes.interior.path({ schemaVersion: "conductor-interior-path-input/v1", layout: current.layout,
            expectedLayoutHash: current.layout.layoutHash, fromNodeId: from.nodeId, toNodeId: target.nodeId, wheelchair: false });
          return { plan, candidate, lengthMm: path.lengthMm };
        }));
      choices.sort((a, b) => a.lengthMm - b.lengthMm || a.plan.id.localeCompare(b.plan.id) || a.candidate.passengerKey.localeCompare(b.candidate.passengerKey));
      assert.ok(choices.length, "The actual source corpus must provide a compatible original situation");
      return choices[0];
    };
    const inspectOriginal = async ({ plan, candidate }, touch = false) => {
      console.log(`Acceptance original dialogue: ${plan.id} (${candidate.treeId})`);
      await driver.walkToPassenger(candidate.passengerKey, plan.id); used.add(candidate.passengerKey);
      const inspect = page.getByRole("button", { name: "Fahrkarte kontrollieren", exact: true });
      if (touch) { await page.setViewportSize({ width: 320, height: 900 }); await driver.tap(inspect); } else await inspect.click();
      await idle();
      let current = await request(); assert.equal(current.snapshot.sessionId, sessionId);
      assert.equal(current.snapshot.activeEncounter.passengerText, candidate.passengerText);
      const encounterId = current.snapshot.activeEncounter.encounterId, utterances = [candidate.passengerText];
      let checked;
      for (const id of plan.options) {
        current = await option(id, ["regular", "provisional", "police"].includes(id), touch && id === "check");
        if (current.snapshot.activeEncounter) utterances.push(current.snapshot.activeEncounter.passengerText);
        if (id === "check") {
          checked = current;
          assert.equal(checked.snapshot.activeEncounter.hints.documentStatus,
            candidate.fareFact === "invalid" ? "verified_invalid" : candidate.fareFact === "valid_unpresentable" ? "not_presentable" : "verified_valid");
          assert.equal(checked.snapshot.activeEncounter.hints.concreteDanger, false);
          await driver.assertAccessibility(checked, plan.id);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await shot(`acceptance-${plan.id}-checked`);
        }
      }
      if (touch) await page.setViewportSize({ width: 1440, height: 1080 });
      const publicCase = current.control.cases.find((row) => row.encounterId === encounterId); assert.ok(publicCase);
      const finish = plan.options.at(-1);
      assert.equal(publicCase.claimKind, ["regular", "provisional"].includes(finish) ? finish : null);
      if (["regular", "provisional"].includes(finish)) assert.equal(publicCase.claimCents, "6000");
      cases.push({ scenario: plan.id, treeId: candidate.treeId, presentation: candidate.presentation, tone: candidate.tone,
        cooperation: candidate.cooperation, utterances, evidence: checked.snapshot.activeEncounter.hints, publicCase,
        sessionId, snapshotHash: current.snapshot.snapshotHash });
      return checked;
    };
    // Choose the shortest real current path among the still-required scenes;
    // no appearance, FareFact, dialogue leaf or native coordinate is changed.
    while (plans.length) {
      const selected = await nearest(plans);
      await inspectOriginal(selected, cases.length === 0);
      plans.splice(plans.indexOf(selected.plan), 1);
    }
    assert.equal(cases.length, 6);
    const police = await nearest([{ id: "police", matches: (row) => row.fareFact === "invalid" && through.has(row.passengerKey), options: ["check"] }]);
    const checked = await inspectOriginal(police);
    assert.equal(checked.snapshot.activeEncounter.hints.identityStatus, "refused");
    await page.reload(); await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl", null, { timeout: 90000 });
    const restored = await request(); assert.deepEqual(restored.snapshot.activeEncounter, checked.snapshot.activeEncounter);
    assert.deepEqual(restored.snapshot.position, checked.snapshot.position);
    const requested = await option("police", true);
    assert.equal(requested.control.hold.status, "requested");
    assert.equal(requested.control.hold.targetStopId, f.initialization.trains[0].stopPlan.stops[1].stopId);
    await shot("acceptance-actual-police-request");
    await command({ type: "clear-disruption", disruptionId: "acceptance:infrastructure-closure", releaseReference: "explicit-test-technical-release:acceptance" });
    await command({ type: "dispatch", requests: [{ trainId: f.access.trainRunId,
      interlockingRouteId: f.initialization.trains[0].dispatchInterlockingRouteId,
      committedRank: 0, timetableDeviationMs: 0, passengerImpact: 0, contractualImpact: 0, networkImpact: 0,
      resourceConsequence: 0, recoveryRank: 0, waitingSinceMs: f.clock.nowMs }] });
    const captureStation = async (current) => {
      if (current.scene?.station && !stationScenes.some((row) => row.station.size === current.scene.station.size)) {
        stationScenes.push(current.scene);
        await page.locator(".conductor-mode").evaluate((element) => { element.scrollTop = 0; });
        await page.waitForFunction((name) => document.querySelector(".conductor-status")?.textContent.includes(name), current.scene.station.name);
        await shot(`acceptance-actual-station-${current.scene.station.size}`);
      }
    };
    const advanceTravel = async (atMs) => {
      if (atMs === f.clock.nowMs) {
        await command({ type: "advance-to", atMs });
        await captureStation(await request());
        return;
      }
      const before = await request();
      if (before.snapshot.status === "ended") {
        if (atMs > f.clock.nowMs) await backend.advance(atMs - f.clock.nowMs);
        return;
      }
      const context = await f.controlContext();
      const segment = context.operationalProjection.trains.find((row) => row.trainId === f.access.trainRunId)?.motionSegment;
      const terminalRouteMm = f.initialization.trains[0].stopPlan.stops.at(-1).routeMm;
      if (segment && segment.segmentEndRouteMm === terminalRouteMm && atMs >= segment.validUntilMs
        && !stationScenes.some((row) => row.station.size === "large")) {
        // Materialize an actual interior time of the committed final motion
        // segment. An ended/frozen snapshot is never presented as an approach.
        const sampleAtMs = segment.validUntilMs - 1;
        if (sampleAtMs > f.clock.nowMs && sampleAtMs < segment.validUntilMs) {
          await driver.advanceKeepingSession(sampleAtMs);
          const approach = await request(); assert.equal(approach.snapshot.status, "active");
          events.push({ kind: "actual-terminal-segment-sample", atMs: sampleAtMs, segment, snapshotHash: approach.snapshot.snapshotHash });
          await captureStation(approach);
        }
      }
      await driver.advanceKeepingSession(atMs);
      await captureStation(await request());
    };
    const tick = async () => {
      const wakeup = await f.nextAcceptanceWakeup(); assert.ok(wakeup.atMs !== null);
      if (wakeup.atMs === f.clock.nowMs) await command({ type: "advance-to", atMs: wakeup.atMs });
      else await advanceTravel(wakeup.atMs);
      const current = await request();
      events.push({ kind: "native-wakeup", ...wakeup, sessionStatus: current.snapshot.status, snapshotHash: current.snapshot.snapshotHash });
      await captureStation(current);
      return current;
    };
    let current = await request();
    const earliestMiddleHoldAtMs = f.initialization.trains[0].stopPlan.stops[1].scheduledDepartureMs;
    if (current.control.hold.status === "requested" && f.clock.nowMs < earliestMiddleHoldAtMs) {
      // Native hold activation cannot precede this pinned scheduled departure.
      // advance-to processes every actual intervening motion/arrival event;
      // this bound does not claim an actual arrival at the planned time.
      await advanceTravel(earliestMiddleHoldAtMs); current = await request();
    }
    for (let count = 0; count < 100 && current.control.hold.status !== "active"; count++) current = await tick();
    assert.equal(current.control.hold.status, "active");
    assert.equal(current.scene.speedMmps, 0);
    await shot("acceptance-actual-middle-police-hold");
    // This driver owns only the real network dispatch/formation sequencing;
    // its time callback keeps the same actual browser session alive.
    const { createConductorNetworkProofDriver } = await import("./network-driver.mjs");
    const network = createConductorNetworkProofDriver({ fixture: f, command, advanceTo: advanceTravel, readSnapshot: request });
    const heldNetwork = await network.startAtActiveHold();
    for (let count = 0; count < 150 && current.control.hold.status !== "released"; count++) current = await tick();
    assert.equal(current.control.hold.status, "released"); assert.equal(current.control.hold.outcome, "identity_confirmed");
    const releasedNetwork = await network.finishAfterRelease();
    current = await request();
    for (let count = 0; count < 150 && current.snapshot.status !== "ended"; count++) current = await tick();
    assert.equal(current.snapshot.sessionId, sessionId); assert.equal(current.snapshot.endReason, "train_completed");
    const finalDemand = await store.latest(f.access.worldId); assert.ok(finalDemand);
    assert.ok(finalDemand.result.revision > initialDemand.result.revision);
    assert.ok(stationScenes.some((row) => row.station.size === "large"));
    await page.getByRole("button", { name: "Kontrollbericht", exact: true }).click(); await reportReady();
    await backend.advanceForReport(f.settlementReadyAtMs);
    const settlement = await f.settleAcceptanceContract();
    assert.ok(BigInt(settlement.contractRevenue.penaltyCents) > 0n);
    assert.equal(settlement.ledgerBalanced, true);
    assert.deepEqual(await f.settleAcceptanceContract(), settlement);
    await page.locator(".conductor-report").getByRole("button", { name: "Bericht aktualisieren", exact: true }).click(); await reportReady();
    const history = await historyRequest(); assert.ok(history.days.length > 0);
    assert.ok(history.days.some((row) => BigInt(row.contractRevenueCents) > 0n));
    await shot("acceptance-connected-native-m6-report");
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot("acceptance-mobile-320-final-report"); assert.deepEqual(driver.errors, []);
    await writeFile(reportPath, JSON.stringify({ schemaVersion: "conductor-acceptance-browser-proof/v1", testOnly: true,
      browser: browser.version(), evidence: backend.evidence, source: f.acceptanceSource, sessionId, cases, events,
      originalFareFactsUnchanged: true, activeDialogReload: true, leaseActivity: driver.leaseActivity,
      accessibilityChecks: driver.accessibilityChecks, heldNetwork, releasedNetwork, stationScenes,
      demand: { initialStateHash: initialDemand.result.stateHash, finalStateHash: finalDemand.result.stateHash,
        initialRevision: initialDemand.result.revision, finalRevision: finalDemand.result.revision,
        stopFlows: finalDemand.result.stopFlows }, settlement, history,
      screenshots: driver.screenshots, pageErrors: driver.errors,
      limits: ["Explicit fictional source configurations and contract; temporary test signatures",
        "Forecast onward services remain forecasts; actual network outcomes come from the native event stream",
        "General daily-plan completeness gate #518 remains closed", "Accessibility-tree checks are not a complete WCAG audit"] }, null, 2) + "\n");
  } catch (error) {
    await page?.screenshot({ path: resolve(output, "acceptance-failure.png"), fullPage: true }).catch(() => {});
    await writeFile(resolve(output, "../acceptance-failure.json"), JSON.stringify({ message: error.message,
      atMs: f.clock.nowMs, preflight, cases, events, leaseActivity: driver?.leaseActivity, requestFailures: driver?.requestFailures,
      commandResponses: driver?.commandResponses, pageErrors: driver?.errors,
      browserText: await page?.locator("body").innerText().catch(() => "unavailable") }, null, 2));
    throw error;
  } finally { await browser?.close(); await backend.close(); }
});
