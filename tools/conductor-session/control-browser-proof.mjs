import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";
import { createFareControlNativeFixture } from "../../apps/game-api/dist/conductor-control.native-fixture.js";
import { ledgerEntries, ledgerTransactions, regionalSimulationStates } from "../../packages/db/dist/index.js";
import { startConductorSessionBrowserBackend } from "./native-backend.mjs";
import { createConductorProofDriver, operationalEventTimes } from "./browser-driver.mjs";
import { assertEncounterAttribution } from "./encounter-proof.mjs";
import { and, eq } from "../../apps/game-api/node_modules/drizzle-orm/index.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
test("one real native browser session connects document checks, claims, proof, payment and police", {
  skip: process.env.CONDUCTOR_CONTROL_BROWSER_TEST !== "1", timeout: 1_200_000,
}, async () => {
  const backend = await startConductorSessionBrowserBackend({ fixtureFactory: () => createFareControlNativeFixture({ identityRefusalBasisPoints: 5000, invalidDocumentPresentedBasisPoints: 10000 }) });
  const output = resolve(process.env.CONDUCTOR_SESSION_SCREENSHOT_DIR ?? resolve(ROOT, "outputs/M15-Sitzung/screenshots"));
  const reportPath = resolve(process.env.CONDUCTOR_CONTROL_REPORT_PATH ?? resolve(output, "../control-browser-report.json"));
  const screenshots = [], checks = [], accessibilityChecks = [], errors = [], commandResponses = [], requestFailures = [], used = new Set();
  let browser, page, largeStationScene;
  try {
    await mkdir(output, { recursive: true });
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : process.platform === "win32" ? { channel: "msedge" } : {}) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce", hasTouch: true });
    const driver = createConductorProofDriver({ backend, page, output, screenshots, accessibilityChecks, errors, commandResponses, requestFailures });
    const { request, shot, historyRequest, reportReady, idle, tap, option, walkToPassenger, assertAccessibility, assertContext } = driver;
    await page.goto(backend.url); await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl", null, { timeout: 90000 });
    const initial = await request(), sessionId = initial.snapshot.sessionId;
    await assertContext();
    await shot("control-confirmed-world-operator-context");
    // A pinned initial native scratch probe is selection metadata only. Every
    // chosen key must still be onboard in the current real projection, and
    // each actual UI inspection independently rechecks its public evidence.
    const candidates = await backend.fixture.inspectionCandidates({ all: true });
    const plans = [
      { id: "verified-valid", fact: "valid", identity: "unknown", finish: "close" },
      { id: "later-valid-proof", fact: "valid_unpresentable", identity: "confirmed", finish: "provisional", paidCents: "700" },
      { id: "invalid-paid-claim", fact: "invalid", identity: "confirmed", finish: "regular", paidCents: "6000" },
      { id: "native-police-hold", fact: "invalid", identity: "refused", finish: "police" },
    ];
    for (const plan of plans) {
      console.log(`Control browser: ${plan.id}`);
      let current = await request();
      const through = new Set(await backend.throughPassengerKeys());
      // This native scratch selection is Node-only. The ensuing actual UI
      // inspection must independently confirm all public hints and outcomes.
      const candidate = candidates.filter((row) => row.fareFact === plan.fact && row.evidence.identityStatus === plan.identity
        && !used.has(row.passengerKey) && through.has(row.passengerKey)).sort((a, b) => a.pathLengthMm - b.pathLengthMm)[0];
      assert.ok(candidate, `The actual M10 corpus must provide an onboard through-passenger for ${plan.id}`);
      if (plan.id === "invalid-paid-claim") console.log(`Original invalid candidate dialogue: ${JSON.stringify(await backend.fixture.candidateDialogue(candidate.passengerKey))}`);
      used.add(candidate.passengerKey);
      current = await walkToPassenger(candidate.passengerKey, plan.id);
      const inspect = page.getByRole("button", { name: "Fahrkarte kontrollieren", exact: true });
      const touch = plan.id === "verified-valid";
      if (touch) { await page.setViewportSize({ width: 320, height: 900 }); await tap(inspect); } else await inspect.click();
      await idle();
      current = await request(); assert.equal(current.snapshot.sessionId, sessionId);
      assert.equal(current.snapshot.activeEncounter.hints.documentStatus, "unchecked");
      const checked = await option("check", false, touch);
      assert.equal(checked.snapshot.activeEncounter.hints.documentStatus, plan.fact === "valid" ? "verified_valid" : plan.fact === "invalid" ? "verified_invalid" : "not_presentable");
      assert.equal(checked.snapshot.activeEncounter.hints.identityStatus, plan.identity);
      await assertEncounterAttribution({ page, request, expectedPassengerKey: candidate.passengerKey });
      await assertAccessibility(checked, plan.id);
      if (touch) {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await shot("control-mobile-320-touch-checked"); await page.setViewportSize({ width: 1440, height: 1080 });
      }
      await shot(`control-${plan.id}-checked`);
      if (plan.finish === "police") {
        await page.reload(); await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl", null, { timeout: 90000 });
        const resumed = await request(); assert.equal(resumed.snapshot.sessionId, sessionId);
        assert.deepEqual(resumed.snapshot.activeEncounter, checked.snapshot.activeEncounter);
        assert.deepEqual(resumed.snapshot.position, checked.snapshot.position);
        const attribution = await assertEncounterAttribution({ page, request, expectedPassengerKey: candidate.passengerKey, selectDifferent: true });
        checks.push({ scenario: "active-dialogue-reload", encounterId: checked.snapshot.activeEncounter.encounterId,
          sessionId, position: resumed.snapshot.position, originalEncounterPreserved: true, attribution });
        await shot("control-active-dialogue-restored");
      }
      const settled = await option(plan.finish, plan.finish !== "close");
      const encounterId = checked.snapshot.activeEncounter.encounterId;
      const publicCase = settled.control.cases.find((row) => row.encounterId === encounterId);
      assert.ok(publicCase);
      if (plan.finish === "close") assert.equal(publicCase.claimKind, null);
      if (plan.finish === "provisional" || plan.finish === "regular") {
        assert.equal(publicCase.claimKind, plan.finish); assert.equal(publicCase.claimCents, "6000");
        const caseSelector = `.conductor-mode .conductor-control-status details[data-case-id="${publicCase.caseId}"]`;
        const claimDetail = page.locator(caseSelector); await claimDetail.locator("summary").click();
        await claimDetail.locator("summary").focus();
        await backend.advance(20001); await page.waitForTimeout(1200);
        const after = await request(), paid = after.control.cases.find((row) => row.caseId === publicCase.caseId);
        assert.equal(paid.paidCents, plan.paidCents);
        await page.waitForFunction(({ selector, amount }) => document.querySelector(selector)?.textContent.includes(`Gezahlt: ${amount} €`),
          { selector: caseSelector, amount: plan.paidCents === "700" ? "7,00" : "60,00" });
        const detail = page.locator(caseSelector);
        assert.equal(await detail.locator("summary").evaluate((element) => element === document.activeElement), true, "Native payment/proof update must preserve the focused case summary");
        assert.equal(await detail.evaluate((element) => element.open), true);
        assert.match(await detail.innerText(), new RegExp(`Gezahlt: ${plan.paidCents === "700" ? "7,00" : "60,00"} €`, "u"));
        if (plan.finish === "provisional") assert.match(await detail.innerText(), /Nachweisfrist:/u);
        await shot(`control-${plan.id}-settled`);
        checks.push({ scenario: plan.id, encounterId, before: publicCase, after: paid, sessionId });
      } else if (plan.finish === "police") {
        assert.ok(settled.control.hold); await shot("control-police-requested");
        await page.getByRole("button", { name: "Kontrollbericht", exact: true }).click(); await reportReady();
        let resolved = settled; const nativeEventSteps = [];
        for (let tick = 0; tick < 80 && resolved.control.hold.status !== "released"; tick++) {
          const fromMs = backend.fixture.clock.nowMs;
          // Follow committed native event boundaries. Once the native hold is
          // active, a short actual polling interval cannot skip its response.
          if (resolved.control.hold.status === "active") {
            nativeEventSteps.push({ fromMs, toMs: fromMs + 250, holdStatus: "active" });
            await backend.advanceForReport(fromMs + 250);
          } else {
            const context = await backend.fixture.controlContext(), world = context.operationalWorld;
            const times = operationalEventTimes(world).filter((atMs) => atMs >= context.nowMs);
            const nextAtMs = Math.min(...times);
            assert.ok(Number.isSafeInteger(nextAtMs) && nextAtMs >= context.nowMs, "A requested hold requires an actual pending operational event");
            nativeEventSteps.push({ fromMs, toMs: nextAtMs, holdStatus: "requested" });
            if (nextAtMs === context.nowMs) {
              await backend.fixture.apply(`control-browser:due-event:${tick}`, { type: "advance-to", atMs: nextAtMs });
              await backend.fixture.refreshConductorCycle();
            } else await backend.advance(nextAtMs - context.nowMs);
            const frame = await request();
            if (!largeStationScene && frame.snapshot.status === "active" && frame.scene?.station?.size === "large") {
              largeStationScene = frame.scene;
              await page.locator(".conductor-report").getByRole("button", { name: "Zurück", exact: true }).click();
              await page.waitForFunction((name) => document.querySelector(".conductor-status")?.textContent.includes(name), frame.scene.station.name);
              await page.locator(".conductor-mode").evaluate((element) => { element.scrollTop = 0; });
              await shot("control-actual-large-approach");
              await page.getByRole("button", { name: "Kontrollbericht", exact: true }).click(); await reportReady();
            }
          }
          await page.locator(".conductor-report").getByRole("button", { name: "Bericht aktualisieren", exact: true }).click(); await reportReady();
          resolved = { control: await historyRequest() };
        }
        assert.equal(resolved.control.hold.status, "released"); assert.equal(resolved.control.hold.outcome, "identity_confirmed");
        checks.push({ scenario: plan.id, before: settled.control.hold, after: resolved.control.hold, nativeEventSteps, sessionId });
        await shot("control-police-resolved");
        await page.locator(".conductor-report").getByRole("button", { name: "Zurück", exact: true }).click();
      } else checks.push({ scenario: plan.id, publicCase, sessionId, input: touch ? "actual touchscreen tap at 320px" : "mouse" });
    }
    // This regression deliberately permits a native lease expiry while the
    // independently persisted hold proceeds. Active full-trip station coverage
    // belongs to the manifest/acceptance browser, not this history check.
    const beforeReload = await request();
    const beforeHistoryReload = await historyRequest(), wasEnded = beforeReload.snapshot.status === "ended";
    await page.reload();
    if (wasEnded) { await page.getByRole("button", { name: "Kontrollbericht öffnen", exact: true }).click(); await reportReady(); }
    else { await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl", null, { timeout: 90000 }); }
    const restored = await request(); assert.equal(restored.snapshot.sessionId, sessionId);
    assert.deepEqual(await historyRequest(), beforeHistoryReload);
    // Keep the real footer report open when native operational progression
    // ends the train and its session. History is independent of a new M10 run.
    if (!wasEnded) await page.getByRole("button", { name: "Kontrollbericht", exact: true }).click();
    const reportDialog = page.locator(".conductor-report"); await reportDialog.waitFor();
    await page.waitForFunction(() => document.querySelector(".conductor-report [role=status]")?.textContent === "Letzter bestätigter Abrechnungsstand.");
    await backend.advanceForReport(86_400_001);
    await reportDialog.getByRole("button", { name: "Bericht aktualisieren", exact: true }).click();
    await reportDialog.locator(".conductor-day").waitFor();
    const history = await historyRequest();
    assert.ok(history.days.length >= 1); assert.equal(history.days[0].dayStartMs, 0);
    await shot("control-native-day-report");
    await reportDialog.getByRole("button", { name: "Zurück", exact: true }).click();
    assert.equal((await request()).snapshot.status, "ended");
    await page.getByRole("button", { name: wasEnded ? "Kontrollbericht öffnen" : "Kontrollbericht", exact: true }).click();
    await page.locator(".conductor-report .conductor-day").waitFor();
    const scope = backend.fixture.access;
    const journals = await backend.fixture.db.select().from(ledgerTransactions).where(and(eq(ledgerTransactions.worldId, scope.worldId), eq(ledgerTransactions.operatorId, scope.operatorId)));
    const entries = await backend.fixture.db.select().from(ledgerEntries).where(eq(ledgerEntries.worldId, scope.worldId));
    for (const journal of journals) assert.equal(entries.filter((row) => row.transactionId === journal.id).reduce((sum, row) => sum + row.amountCents, 0n), 0n);
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot("control-mobile-320-ended-day-report"); assert.deepEqual(errors, []);
    await writeFile(reportPath, `${JSON.stringify({ schemaVersion: "conductor-control-browser-proof/v1", browser: browser.version(), evidence: backend.evidence,
      sessionId, checks, accessibilityChecks, history, largeStationScene: largeStationScene ?? null,
      nativeEndReason: (await request()).snapshot.endReason, reportAfterSessionEnd: true, balancedLedgerTransactions: journals.length, ledgerEntryCount: entries.length, screenshots, pageErrors: errors,
      limits: ["Explicit fictional game tariff and sources", "Native scratch runs select test targets only; all reported controls occur through actual UI and API",
        "Actual browser accessibility-tree checks; no complete WCAG audit or screen-reader user study"] }, null, 2)}\n`);
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(output, "control-failure.png"), fullPage: true }).catch(() => {});
    const regionHeads = await backend.fixture.db.select().from(regionalSimulationStates).then((rows) => rows
      .filter((row) => row.worldId === backend.fixture.access.worldId).map((row) => ({ worldId: row.worldId, regionId: row.regionId,
        revision: row.revision, stateHash: row.stateHash, publisherSequence: row.state.publisherSequence, nowMs: row.state.world.nowMs }))).catch(() => []);
    await writeFile(resolve(output, "../control-failure.json"), JSON.stringify({ message: error.message, atMs: backend.fixture.clock.nowMs,
      browserText: await page?.locator("body").innerText().catch(() => "unavailable"), checks, accessibilityChecks, screenshots, commandResponses, requestFailures, regionHeads, pageErrors: errors }, null, 2));
    throw error;
  } finally { await browser?.close(); await backend.close(); }
});
