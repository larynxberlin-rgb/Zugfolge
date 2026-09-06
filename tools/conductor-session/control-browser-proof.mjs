import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";
import { createFareControlNativeFixture } from "../../apps/game-api/dist/conductor-control.native-fixture.js";
import { ledgerEntries, ledgerTransactions } from "../../packages/db/dist/index.js";
import { startConductorSessionBrowserBackend } from "./native-backend.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("one real native browser session connects document checks, claims, proof, payment and police", {
  skip: process.env.CONDUCTOR_CONTROL_BROWSER_TEST !== "1", timeout: 1_200_000,
}, async () => {
  const backend = await startConductorSessionBrowserBackend({ fixtureFactory: () => createFareControlNativeFixture({ identityRefusalBasisPoints: 5000 }) });
  const output = resolve(process.env.CONDUCTOR_SESSION_SCREENSHOT_DIR ?? resolve(ROOT, "outputs/M15-Sitzung/screenshots"));
  const reportPath = resolve(process.env.CONDUCTOR_CONTROL_REPORT_PATH ?? resolve(output, "../control-browser-report.json"));
  const screenshots = [], checks = [], errors = [], used = new Set();
  let browser, page;
  try {
    await mkdir(output, { recursive: true });
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : process.platform === "win32" ? { channel: "msedge" } : {}) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(60000); page.on("pageerror", (error) => errors.push(error.message));
    const request = async () => {
      const response = await page.request.get(`${new URL(backend.url).origin}${backend.route}/snapshot`, { headers: { authorization: `Bearer ${backend.token}` } });
      assert.equal(response.status(), 200, await response.text());
      const text = await response.text();
      assert.doesNotMatch(text, /"fareFact"|"ownerRef"|"keycloakSubject"|"inspectionPolicy"/u);
      const value = JSON.parse(text);
      assert.doesNotMatch(JSON.stringify(value.control), /"passengerKey"|"seedHash"|"responseAfterActivation"|"identityConfirmed"/u);
      return value;
    };
    const shot = async (name) => {
      const file = `${name}.png`, bytes = await page.screenshot({ path: resolve(output, file), fullPage: true });
      screenshots.push({ file, sha256: sha(bytes), viewport: page.viewportSize() });
    };
    const idle = async () => {
      await page.waitForFunction(() => !document.querySelector(".conductor-status")?.textContent.includes("wird bestätigt"));
      assert.equal(await page.locator(".conductor-problem").isVisible(), false, await page.locator(".conductor-problem").textContent());
    };
    const option = async (id, confirmation = false) => {
      const before = await request(), encounter = before.snapshot.activeEncounter;
      assert.ok(encounter);
      if (encounter.availableAtMs > backend.fixture.clock.nowMs) {
        await backend.advance(encounter.availableAtMs - backend.fixture.clock.nowMs); await page.waitForTimeout(1200);
      }
      const current = await request(), choice = current.snapshot.activeEncounter.options.find((row) => row.optionId === id);
      assert.ok(choice, `Actual checked dialogue must offer ${id}`);
      const button = page.getByRole("button", { name: `${choice.text} · ${choice.timeCostMs / 1000} s`, exact: true });
      await button.click();
      if (confirmation) {
        const confirm = page.locator(".conductor-confirm"); await confirm.waitFor();
        assert.equal(await confirm.getByRole("button", { name: "Abbrechen", exact: true }).evaluate((element) => element === document.activeElement), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await confirm.evaluate((element) => element.contains(document.activeElement)), true);
        await confirm.getByRole("button", { name: "Bestätigen", exact: true }).click();
      }
      await idle(); return request();
    };
    await page.goto(backend.url); await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl", null, { timeout: 90000 });
    const initial = await request(), sessionId = initial.snapshot.sessionId;
    const plans = [
      { id: "verified-valid", fact: "valid", identity: "unknown", finish: "close" },
      { id: "later-valid-proof", fact: "valid_unpresentable", identity: "confirmed", finish: "provisional", paidCents: "700" },
      { id: "invalid-paid-claim", fact: "invalid", identity: "confirmed", finish: "provisional", paidCents: "6000" },
      { id: "native-police-hold", fact: "invalid", identity: "refused", finish: "police" },
    ];
    for (const plan of plans) {
      console.log(`Control browser: ${plan.id}`);
      let current = await request();
      const through = new Set(await backend.throughPassengerKeys());
      // This native scratch selection is Node-only. The ensuing actual UI
      // inspection must independently confirm all public hints and outcomes.
      const candidates = await backend.fixture.inspectionCandidates({ all: true });
      const candidate = candidates.filter((row) => row.fareFact === plan.fact && row.evidence.identityStatus === plan.identity
        && !used.has(row.passengerKey) && through.has(row.passengerKey)).sort((a, b) => a.pathLengthMm - b.pathLengthMm)[0];
      assert.ok(candidate, `The actual M10 corpus must provide an onboard through-passenger for ${plan.id}`);
      used.add(candidate.passengerKey);
      const index = current.snapshot.passengers.passengers.findIndex((person) => person.passengerKey === candidate.passengerKey && person.activity === "onboard");
      assert.ok(index >= 0); await page.locator(".conductor-passenger").nth(index).click();
      const person = current.snapshot.passengers.passengers[index];
      const targetId = person.spaceNeeds === "wheelchair" ? person.spaceId : person.placeId;
      const interaction = current.layout.interactions.find((row) => row.targetId === targetId);
      assert.ok(interaction);
      const target = current.layout.nodes.find((row) => row.nodeId === interaction.nodeId)?.point;
      assert.ok(target);
      const atTarget = (position) => ["vehicleId", "bodyId", "deckId", "xMm", "yMm"].every((key) => position[key] === target[key]);
      const inspect = page.getByRole("button", { name: "Fahrkarte kontrollieren", exact: true });
      if (!atTarget(current.snapshot.position)) {
        await page.getByRole("button", { name: "Zum Fahrgast gehen", exact: true }).click();
        for (let step = 0; step < 140 && !atTarget(current.snapshot.position); step++) {
          await backend.advance(1500); await page.waitForTimeout(800); current = await request();
          assert.equal(await page.locator(".conductor-problem").isVisible(), false, await page.locator(".conductor-problem").textContent());
        }
        assert.equal(atTarget(current.snapshot.position), true, `Actual native path did not reach ${plan.id}`);
        await page.getByRole("button", { name: "Weg abbrechen", exact: true }).click();
      }
      await inspect.click(); await idle();
      current = await request(); assert.equal(current.snapshot.sessionId, sessionId);
      assert.equal(current.snapshot.activeEncounter.hints.documentStatus, "unchecked");
      const checked = await option("check");
      assert.equal(checked.snapshot.activeEncounter.hints.documentStatus, plan.fact === "valid" ? "verified_valid" : "not_presentable");
      assert.equal(checked.snapshot.activeEncounter.hints.identityStatus, plan.identity);
      await shot(`control-${plan.id}-checked`);
      const settled = await option(plan.finish, plan.finish !== "close");
      const encounterId = checked.snapshot.activeEncounter.encounterId;
      const publicCase = settled.control.cases.find((row) => row.encounterId === encounterId);
      assert.ok(publicCase);
      if (plan.finish === "close") assert.equal(publicCase.claimKind, null);
      if (plan.finish === "provisional") {
        assert.equal(publicCase.claimKind, "provisional"); assert.equal(publicCase.claimCents, "6000");
        await backend.advance(20001); await page.waitForTimeout(1200);
        const after = await request(), paid = after.control.cases.find((row) => row.caseId === publicCase.caseId);
        assert.equal(paid.paidCents, plan.paidCents); await shot(`control-${plan.id}-settled`);
        checks.push({ scenario: plan.id, encounterId, before: publicCase, after: paid, sessionId });
      } else if (plan.finish === "police") {
        assert.ok(settled.control.hold); await shot("control-police-requested");
        let resolved = settled;
        for (let tick = 0; tick < 12 && resolved.control.hold.status !== "released"; tick++) {
          await backend.advance(10000); await page.waitForTimeout(1200); resolved = await request();
        }
        assert.equal(resolved.control.hold.status, "released"); assert.equal(resolved.control.hold.outcome, "identity_confirmed");
        checks.push({ scenario: plan.id, before: settled.control.hold, after: resolved.control.hold, sessionId });
        await shot("control-police-resolved");
      } else checks.push({ scenario: plan.id, publicCase, sessionId });
    }
    const beforeReload = await request();
    await page.reload(); await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl", null, { timeout: 90000 });
    const restored = await request(); assert.equal(restored.snapshot.sessionId, sessionId);
    assert.deepEqual(restored.control, beforeReload.control);
    // Keep the real footer report open when native operational progression
    // ends the train and its session. History is independent of a new M10 run.
    await page.getByRole("button", { name: "Kontrollbericht", exact: true }).click();
    const reportDialog = page.locator(".conductor-report"); await reportDialog.waitFor();
    await page.waitForFunction(() => document.querySelector(".conductor-report [role=status]")?.textContent === "Letzter bestätigter Abrechnungsstand.");
    await backend.advanceForReport(86_400_001);
    await reportDialog.getByRole("button", { name: "Bericht aktualisieren", exact: true }).click();
    await reportDialog.locator(".conductor-day").waitFor();
    const historyResponse = await page.request.get(`${new URL(backend.url).origin}${backend.route}/report`, { headers: { authorization: `Bearer ${backend.token}` } });
    assert.equal(historyResponse.status(), 200); const history = await historyResponse.json();
    assert.ok(history.days.length >= 1); assert.equal(history.days[0].dayStartMs, 0);
    await shot("control-native-day-report");
    await reportDialog.getByRole("button", { name: "Zurück", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".conductor-status")?.textContent.includes("beendet"));
    await page.getByRole("button", { name: "Kontrollbericht", exact: true }).click();
    await page.locator(".conductor-report .conductor-day").waitFor();
    const journals = await backend.fixture.db.select().from(ledgerTransactions), entries = await backend.fixture.db.select().from(ledgerEntries);
    for (const journal of journals) assert.equal(entries.filter((row) => row.transactionId === journal.id).reduce((sum, row) => sum + row.amountCents, 0n), 0n);
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot("control-mobile-320-ended-day-report"); assert.deepEqual(errors, []);
    await writeFile(reportPath, `${JSON.stringify({ schemaVersion: "conductor-control-browser-proof/v1", browser: browser.version(), evidence: backend.evidence,
      sessionId, checks, history, reportAfterSessionEnd: true, balancedLedgerTransactions: journals.length, ledgerEntryCount: entries.length, screenshots, pageErrors: errors,
      limits: ["Explicit fictional game tariff and sources", "Native scratch runs select test targets only; all reported controls occur through actual UI and API"] }, null, 2)}\n`);
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(output, "control-failure.png"), fullPage: true }).catch(() => {});
    await writeFile(resolve(output, "../control-failure.json"), JSON.stringify({ message: error.message, atMs: backend.fixture.clock.nowMs,
      browserText: await page?.locator("body").innerText().catch(() => "unavailable"), checks, screenshots, pageErrors: errors }, null, 2));
    throw error;
  } finally { await browser?.close(); await backend.close(); }
});
