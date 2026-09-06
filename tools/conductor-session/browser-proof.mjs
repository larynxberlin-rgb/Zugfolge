import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";
import { startConductorSessionBrowserBackend } from "./native-backend.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const enabled = process.env.CONDUCTOR_SESSION_BROWSER_TEST === "1";
test("actual conductor DOM and Pixi WebGL on committed native DB/API facts", { skip: !enabled, timeout: 600000 }, async () => {
  const backend = await startConductorSessionBrowserBackend();
  const output = resolve(process.env.CONDUCTOR_SESSION_SCREENSHOT_DIR ?? resolve(ROOT, "outputs/M15-Sitzung/screenshots"));
  const reportPath = resolve(process.env.CONDUCTOR_SESSION_REPORT_PATH ?? resolve(output, "../browser-report.json"));
  await mkdir(output, { recursive: true }); await mkdir(dirname(reportPath), { recursive: true });
  let browser, page;
  const screenshots = [], errors = [], actions = [], layouts = [], scenes = [];
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : process.platform === "win32" ? { channel: "msedge" } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce" });
    page = await context.newPage(); page.setDefaultTimeout(45000);
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = new URL(backend.url).origin;
    const request = async (path = "/snapshot") => {
      const response = await page.request.get(`${origin}${backend.route}${path}`, { headers: { authorization: `Bearer ${backend.token}` } });
      assert.equal(response.status(), 200, await response.text()); return response.json();
    };
    const screenshot = async (name) => {
      const file = `${name}.png`, bytes = await page.screenshot({ path: resolve(output, file), fullPage: true });
      screenshots.push({ file, sha256: sha(bytes), viewport: page.viewportSize() });
    };
    const layout = async (name) => {
      const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        dialogWidth: document.querySelector(".conductor-mode")?.clientWidth, dialogScrollWidth: document.querySelector(".conductor-mode")?.scrollWidth }));
      assert.ok(dimensions.scrollWidth <= dimensions.width, `${name}: page overflow`);
      assert.ok(dimensions.dialogScrollWidth <= dimensions.dialogWidth + 1, `${name}: dialog overflow ${JSON.stringify(dimensions)}`);
      layouts.push({ name, ...dimensions });
    };
    const ready = async () => {
      await page.waitForFunction(() => document.querySelector(".conductor-stage canvas")?.dataset.renderer === "webgl"
        || document.querySelector(".conductor-problem")?.hidden === false, null, { timeout: 90000 });
      assert.equal(await page.locator(".conductor-problem").isVisible(), false, await page.locator(".conductor-problem").textContent());
      assert.equal(await page.locator("canvas").getAttribute("data-renderer"), "webgl");
    };
    await page.goto(backend.url); await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click(); await ready();
    console.log("Browserproof: WebGL ready");
    const initial = await request(), art = await request("/art"), atlasFiles = [];
    assert.equal(initial.snapshot.status, "active"); assert.ok(initial.snapshot.passengers.passengers.length > 0);
    assert.equal(initial.scene.station.size, "small"); assert.equal(initial.scene.lighting.phase, "day");
    scenes.push(initial.scene);
    assert.equal(initial.layout.capacity.standardSeats, 104); assert.equal(initial.layout.capacity.premiumSeats, 16); assert.equal(initial.layout.capacity.standardStanding, 40);
    assert.equal(await page.locator(".conductor-passenger").count(), initial.snapshot.passengers.passengers.length);
    assert.equal(Number(await page.locator("canvas").getAttribute("data-logical-passengers")), initial.snapshot.passengers.passengers.length);
    assert.equal(await page.locator("canvas").getAttribute("data-reduced-motion"), "true");
    assert.equal(art.files.length, 7);
    for (const file of art.files) {
      const response = await page.request.get(`${origin}${backend.route}/atlas/${file.id}`, { headers: { authorization: `Bearer ${backend.token}` } });
      assert.equal(response.status(), 200); const bytes = await response.body(); assert.equal(sha(bytes), file.sha256);
      atlasFiles.push({ fileId: file.id, sha256: sha(bytes), bytes: bytes.length });
    }
    await layout("desktop"); await screenshot("desktop-entry");
    console.log("Browserproof: original atlas bytes and full manifest checked");
    await page.getByRole("combobox").nth(1).selectOption("4");
    assert.ok(Number(await page.locator("canvas").getAttribute("data-visible-passengers")) < initial.snapshot.passengers.passengers.length);
    assert.equal(await page.locator(".conductor-passenger").count(), initial.snapshot.passengers.passengers.length);
    await screenshot("desktop-4x-complete-list");
    await page.getByRole("combobox").nth(1).selectOption("2");
    await page.locator(".conductor-passenger").first().click();
    assert.equal(await page.locator(".conductor-passenger").first().getAttribute("aria-pressed"), "true");
    await screenshot("desktop-passenger-selected");
    await page.locator(".conductor-stage").focus();
    const before = await request();
    await backend.advance(1000);
    const current = await request();
    await page.waitForTimeout(1200); // actual route polling must publish the newly committed clock before the key action
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => !document.querySelector(".conductor-status")?.textContent.includes("wird bestätigt"));
    const moved = await request();
    assert.notDeepEqual(moved.snapshot.position, before.snapshot.position, await page.locator(".conductor-problem").textContent());
    assert.equal(moved.snapshot.position.xMm, current.snapshot.position.xMm + 500);
    actions.push({ action: "keyboard-move", before: current.snapshot.position, after: moved.snapshot.position,
      beforeHash: current.snapshot.snapshotHash, afterHash: moved.snapshot.snapshotHash });
    assert.ok(moved.scene.routeMm > initial.scene.routeMm); assert.ok(moved.scene.speedMmps > 0); scenes.push(moved.scene);
    await screenshot("desktop-confirmed-keyboard-move");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.reducedMotion === "false");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.playerAnimation === "idle");
    backend.disconnectStreams();
    await page.waitForFunction(() => document.querySelector(".conductor-status")?.textContent.includes("Verbindung unterbrochen"));
    assert.equal(await page.getByRole("button", { name: "Gehen →", exact: true }).isDisabled(), true);
    await screenshot("desktop-disconnected-readonly");
    await page.getByRole("button", { name: "Verbindung wiederherstellen", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".conductor-status")?.textContent.includes("Verbindung unterbrochen"));
    assert.deepEqual((await request()).snapshot.position, moved.snapshot.position);
    actions.push({ action: "authenticated-sse-reconnect", positionPreserved: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 }); await layout(`mobile-${width}`);
      assert.equal(await page.locator(".conductor-passenger").count(), initial.snapshot.passengers.passengers.length);
      await screenshot(`mobile-${width}`);
    }
    await page.keyboard.press("Escape"); await page.locator(".conductor-mode").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).evaluate((button) => button === document.activeElement), true);
    const detached = await request(); assert.equal(detached.snapshot.status, "detached");
    await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click(); await ready();
    const resumed = await request(); assert.equal(resumed.snapshot.sessionId, initial.snapshot.sessionId); assert.equal(resumed.snapshot.status, "active");
    assert.deepEqual(resumed.snapshot.position, moved.snapshot.position);
    await screenshot("mobile-320-resumed-session");
    console.log("Browserproof: mobile, disconnect and resume checked");
    await page.setViewportSize({ width: 1440, height: 1080 });
    for (const [index, body] of initial.layout.vehicles[0].bodies.entries()) {
      await page.getByRole("combobox").nth(0).selectOption(`0|${index}|main`);
      assert.deepEqual((await request()).snapshot.position, resumed.snapshot.position);
      await screenshot(`desktop-body-${index + 1}`);
      actions.push({ action: "view-only-body-change", bodyId: body.bodyId, positionPreserved: true });
    }
    await page.getByRole("button", { name: "Zu meiner Position", exact: true }).click();
    // Select a real projected passenger in the next body. The actual UI asks the
    // server for a path and submits every movement; the harness supplies no path.
    const nextBody = initial.layout.vehicles[0].bodies[1].bodyId;
    const indexInNextBody = resumed.snapshot.passengers.passengers.findIndex((person) => person.bodyId === nextBody && person.activity === "onboard");
    assert.ok(indexInNextBody >= 0);
    await page.locator(".conductor-passenger").nth(indexInNextBody).click();
    await page.getByRole("button", { name: "Zum Fahrgast gehen", exact: true }).click();
    let crossed = resumed;
    for (let step = 0; step < 65 && crossed.snapshot.position.bodyId !== nextBody; step++) {
      await backend.advance(1500); await page.waitForTimeout(800); crossed = await request();
      const problem = await page.locator(".conductor-problem").textContent();
      assert.equal(await page.locator(".conductor-problem").isVisible(), false, problem);
    }
    assert.equal(crossed.snapshot.position.bodyId, nextBody, "UI path must cross the native gangway");
    await page.getByRole("button", { name: "Weg abbrechen", exact: true }).click();
    await page.getByRole("button", { name: "Zu meiner Position", exact: true }).click();
    actions.push({ action: "server-path-and-gangway", before: resumed.snapshot.position, after: crossed.snapshot.position,
      approvedGangwayEdges: initial.layout.edges.filter((edge) => edge.kind === "gangway").map((edge) => edge.edgeId) });
    await screenshot("desktop-native-gangway-crossed");
    console.log("Browserproof: actual native gangway crossed");
    await backend.advance(60000); const atStop = await request();
    assert.equal(atStop.scene.station.size, "medium"); assert.equal(atStop.scene.speedMmps, 0);
    assert.equal(atStop.scene.station.atPlatform, true); scenes.push(atStop.scene);
    await page.waitForTimeout(1200); await screenshot("desktop-actual-medium-stop");
    await backend.advance(1000); const stillStopped = await request();
    assert.equal(stillStopped.scene.environment.scrollMm, atStop.scene.environment.scrollMm);
    assert.equal(stillStopped.scene.speedMmps, 0); scenes.push(stillStopped.scene);
    assert.equal(await page.locator(".conductor-passenger").count(), stillStopped.snapshot.passengers.passengers.length);
    assert.deepEqual(errors, []);
    const report = { schemaVersion: "conductor-session-browser-proof/v1", browser: { name: process.platform === "win32" ? "Microsoft Edge" : "Chromium", version: browser.version(), backend: "webgl" },
      evidence: backend.evidence, component: "apps/livemap/src/conductor-mode.ts", renderer: "apps/livemap/src/conductor-renderer.ts",
      authority: { nativeGeometry: true, actualOperationalDepartures: true, actualM10Passengers: true, persistedSession: true, browserConstructedSnapshots: false },
      capacity: initial.layout.capacity, fullPassengerCount: initial.snapshot.passengers.passengers.length, layoutHash: initial.layout.layoutHash,
      artManifestHash: art.manifestSha256, atlasFiles, actions, layouts, scenes, screenshots, pageErrors: errors,
      limits: ["Explicit fictional source geography and game vehicle configurations", "Temporary test signature, no productive world activation",
        "This initial fixture exercises one main-deck formation; double-deck session and control-domain flows require their own positive checks"] };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ reportPath, screenshots: screenshots.length, fullPassengerCount: report.fullPassengerCount, atlasFiles: atlasFiles.length }));
  } catch (error) {
    const browserText = await page?.locator("body").innerText().catch(() => "Browser unavailable");
    if (page) await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(resolve(dirname(reportPath), "failure.json"), JSON.stringify({ message: error.message, browserText, pageErrors: errors, screenshots }, null, 2));
    throw error;
  } finally { await browser?.close(); await backend.close(); }
});

test("actual native night scene and red signals after a committed infrastructure closure", { skip: !enabled, timeout: 240000 }, async () => {
  const backend = await startConductorSessionBrowserBackend({ sceneEpochUtcTimeOfDayMs: 0 });
  const output = resolve(process.env.CONDUCTOR_SESSION_SCREENSHOT_DIR ?? resolve(ROOT, "outputs/M15-Sitzung/screenshots"));
  const mainReport = resolve(process.env.CONDUCTOR_SESSION_REPORT_PATH ?? resolve(output, "../browser-report.json"));
  let browser;
  const screenshots = [], errors = [];
  try {
    await mkdir(output, { recursive: true });
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : process.platform === "win32" ? { channel: "msedge" } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(error.message));
    const request = async () => {
      const response = await page.request.get(`${new URL(backend.url).origin}${backend.route}/snapshot`, { headers: { authorization: `Bearer ${backend.token}` } });
      assert.equal(response.status(), 200, await response.text()); return response.json();
    };
    const shot = async (name) => {
      const file = `${name}.png`, bytes = await page.screenshot({ path: resolve(output, file), fullPage: true });
      screenshots.push({ file, sha256: sha(bytes), viewport: page.viewportSize() });
    };
    await page.goto(backend.url); await page.getByRole("button", { name: "Schaffnermodus öffnen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl", null, { timeout: 90000 });
    const night = await request();
    assert.equal(night.scene.lighting.phase, "night"); assert.equal(night.scene.lighting.daylightBasisPoints, 2500);
    assert.equal(night.scene.lighting.windowLightBasisPoints, 7500);
    await shot("desktop-native-night");
    // A real privileged infrastructure command produces the stop and signal
    // aspects. The browser cannot set its own operational state or red lights.
    const closure = { type: "activate-disruption", disruptionId: "proof:confirmed-resource-closure",
      effect: { "resource-closed": { resourceId: "block:stop:2" } } };
    await backend.fixture.apply("proof:block-next", closure); await backend.fixture.refresh();
    const stopped = await request();
    assert.equal(stopped.scene.motionState, "safe-stop"); assert.equal(stopped.scene.waitingReason, "infrastructure-disruption");
    assert.equal(stopped.scene.speedMmps, 0); assert.ok(stopped.scene.signals.some((signal) => signal.aspect === "stop"));
    await page.waitForTimeout(1500); await shot("desktop-native-red-signal-stop");
    await backend.advance(1000); const stillStopped = await request();
    assert.equal(stillStopped.scene.routeMm, stopped.scene.routeMm);
    assert.equal(stillStopped.scene.environment.scrollMm, stopped.scene.environment.scrollMm);
    assert.equal(stillStopped.scene.speedMmps, 0);
    await page.setViewportSize({ width: 320, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot("mobile-320-native-night-stop");
    assert.deepEqual(errors, []);
    const report = { schemaVersion: "conductor-session-scene-browser-proof/v1", browser: browser.version(), evidence: backend.evidence,
      sourceRule: "Pinned authored midnight epoch on explicit fictional geography; all stop, route, time and signal facts come from native committed state",
      closure, scenes: [night.scene, stopped.scene, stillStopped.scene], screenshots, pageErrors: errors };
    await writeFile(resolve(dirname(mainReport), "scene-browser-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  } finally { await browser?.close(); await backend.close(); }
});
