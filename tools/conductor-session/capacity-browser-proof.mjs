import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";
import { createConductorSessionNativeFixture } from "../../apps/game-api/dist/conductor-session.native-fixture.js";
import { startConductorSessionBrowserBackend } from "./native-backend.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const noControlEffects = {
  async evidence() { return { encounterEvidence: [], controlReceipts: [] }; },
  async apply(_tx, _context, _state, effects) { assert.deepEqual(effects, [], "No control-domain effect is configured in this capacity proof."); },
};
const stats = (samples) => ({ samplesMs: samples, p95Ms: [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] });

test("the complete 220-passenger M5 double-deck configuration remains accessible through the actual browser and native stairs", {
  skip: process.env.CONDUCTOR_CAPACITY_BROWSER_TEST !== "1", timeout: 360000,
}, async () => {
  const backend = await startConductorSessionBrowserBackend({ fixtureFactory: () => createConductorSessionNativeFixture(noControlEffects, { configurationIndex: 2 }) });
  const output = resolve(process.env.CONDUCTOR_SESSION_SCREENSHOT_DIR ?? resolve(ROOT, "outputs/M15-Sitzung/screenshots"));
  const reportPath = resolve(process.env.CONDUCTOR_CAPACITY_REPORT_PATH ?? resolve(output, "../capacity-browser-report.json"));
  let browser, page;
  const screenshots = [], errors = [], timings = [];
  try {
    await mkdir(output, { recursive: true }); await mkdir(dirname(reportPath), { recursive: true });
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : process.platform === "win32" ? { channel: "msedge" } : {}) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce", hasTouch: true });
    page.setDefaultTimeout(60000); page.on("pageerror", (error) => errors.push(error.message));
    const request = async () => {
      const response = await page.request.get(`${new URL(backend.url).origin}${backend.route}/snapshot`, { headers: { authorization: `Bearer ${backend.token}` } });
      assert.equal(response.status(), 200, await response.text()); return response.json();
    };
    const shot = async (name) => {
      const file = `${name}.png`, bytes = await page.screenshot({ path: resolve(output, file), fullPage: true });
      screenshots.push({ file, sha256: createHash("sha256").update(bytes).digest("hex"), viewport: page.viewportSize() });
    };
    await page.goto(backend.url); await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl", null, { timeout: 90000 });
    const initial = await request(), people = initial.snapshot.passengers.passengers;
    assert.equal(people.length, 220); assert.equal(new Set(people.map((row) => row.passengerKey)).size, 220);
    assert.equal(initial.layout.capacity.standardSeats + initial.layout.capacity.premiumSeats, 200);
    assert.equal(initial.layout.capacity.standardStanding, 20);
    assert.equal(initial.layout.vehicles[0].bodies.length, 3);
    assert.ok(initial.layout.edges.some((edge) => edge.kind === "stair"));
    assert.ok(initial.layout.vehicles[0].bodies.every((body) => body.deckIds.includes("lower") && body.deckIds.includes("upper")));
    assert.equal(await page.locator(".conductor-passenger").count(), 220);
    assert.equal(await page.locator("canvas").getAttribute("data-logical-passengers"), "220");
    await shot("capacity-desktop-220-lower");
    for (let index = 0; index < 12; index++) {
      const started = performance.now(); const current = await request();
      timings.push(performance.now() - started); assert.deepEqual(current.snapshot.position, initial.snapshot.position);
    }
    const frameMeasurements = [];
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1080 : 900 });
      const samples = await page.evaluate(async () => {
        const select = document.querySelector(".conductor-tools select"), samples = [];
        // The real select handler renders each full deck; this measures host
        // input-to-next-frame latency, not an invented native or GPU budget.
        for (let index = 0; index < 24; index++) {
          const started = performance.now(); select.value = `0|0|${index % 2 ? "lower" : "upper"}`;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)); samples.push(performance.now() - started);
        }
        return samples;
      });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator(".conductor-passenger").count(), 220);
      assert.equal(await page.locator("canvas").getAttribute("data-logical-passengers"), "220");
      frameMeasurements.push({ width, height: page.viewportSize().height, ...stats(samples) });
    }
    await page.getByRole("combobox").nth(0).selectOption("0|0|upper");
    await shot("capacity-mobile-320-upper-220");
    assert.deepEqual((await request()).snapshot.position, initial.snapshot.position, "Deck browsing must never move the player.");
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.getByRole("button", { name: "Zu meiner Position", exact: true }).click();
    const through = new Set(await backend.throughPassengerKeys());
    const targetPerson = people.filter((row) => row.bodyId === initial.snapshot.position.bodyId && row.deckId === "upper"
      && row.activity === "onboard" && through.has(row.passengerKey)).sort((a, b) => a.xMm - b.xMm)[0];
    assert.ok(targetPerson, "Actual M10 must provide a through-passenger on the upper deck.");
    await page.locator(".conductor-passenger").nth(people.findIndex((row) => row.passengerKey === targetPerson.passengerKey)).click();
    await page.getByRole("button", { name: "Zum Fahrgast gehen", exact: true }).click();
    let crossed = await request();
    for (let step = 0; step < 65 && crossed.snapshot.position.deckId !== "upper"; step++) {
      await backend.advance(1500); await page.waitForTimeout(800); crossed = await request();
      assert.equal(await page.locator(".conductor-problem").isVisible(), false, await page.locator(".conductor-problem").textContent());
    }
    assert.equal(crossed.snapshot.position.deckId, "upper", "The server must authorize a real stair edge.");
    await page.getByRole("button", { name: "Weg abbrechen", exact: true }).click();
    // Stopping the remaining path cannot revoke an already submitted move.
    await page.waitForFunction(() => !document.querySelector(".conductor-status")?.textContent.includes("wird bestätigt"));
    crossed = await request(); assert.equal(crossed.snapshot.position.deckId, "upper");
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.deck === "upper");
    assert.equal(await page.getByRole("combobox").nth(0).inputValue(), "0|0|upper");
    await shot("capacity-desktop-native-stairs");
    await page.setViewportSize({ width: 320, height: 900 });
    assert.ok(await page.evaluate(() => navigator.maxTouchPoints > 0));
    const pan = page.getByRole("button", { name: "Ansicht →", exact: true }); await pan.scrollIntoViewIfNeeded();
    const box = await pan.boundingBox(); assert.ok(box); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    assert.deepEqual((await request()).snapshot.position, crossed.snapshot.position);
    assert.equal(await page.locator(".conductor-passenger").count(), 220);
    await shot("capacity-mobile-320-confirmed-upper");
    assert.deepEqual(errors, []);
    const report = { schemaVersion: "conductor-session-capacity-browser-proof/v1", evidence: backend.evidence,
      browser: { version: browser.version(), platform: process.platform, arch: process.arch },
      runtimeTransport: process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH ? "Linux NAPI addon" : "Native Rust test CLI processes",
      capacity: initial.layout.capacity, fullPassengerCount: people.length, layoutHash: initial.layout.layoutHash,
      stairs: { before: initial.snapshot.position, after: crossed.snapshot.position, edges: initial.layout.edges.filter((edge) => edge.kind === "stair") },
      measurements: { authenticatedSnapshotLocalRoundTrip: stats(timings), deckChangeToNextAnimationFrame: frameMeasurements },
      limits: ["Largest complete fictional M5 configuration in this corpus, not a globally approved maximal SPNV formation",
        "Local real DB and native runtime transport; Vite development browser build; descriptive measurements without a productive budget assertion",
        "Temporary test signatures; no productive world activation"], screenshots, pageErrors: errors };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ reportPath, fullPassengerCount: people.length, screenshots: screenshots.length, measurements: report.measurements }));
  } catch (error) {
    if (page) await page.screenshot({ path: resolve(output, "capacity-failure.png"), fullPage: true }).catch(() => {});
    await writeFile(resolve(dirname(reportPath), "capacity-failure.json"), JSON.stringify({ message: error.message,
      browserText: await page?.locator("body").innerText().catch(() => "unavailable"), pageErrors: errors }, null, 2));
    throw error;
  } finally { await browser?.close(); await backend.close(); }
});
