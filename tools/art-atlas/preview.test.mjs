import assert from "node:assert/strict";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startArtPreviewServer } from "./server.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const close = (server) => new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
const rawRequest = (port, path, options = {}) => new Promise((done, reject) => {
  const outgoing = request({ hostname: "127.0.0.1", port, path, ...options }, (response) => {
    const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
  }); outgoing.on("error", reject); outgoing.end();
});

test("art preview serves only local, read-only, explicitly declared release paths", async () => {
  const server = await startArtPreviewServer({ port: 0 });
  try {
    assert.equal(server.address().address, "127.0.0.1");
    const port = server.address().port;
    const home = await rawRequest(port, "/");
    assert.equal(home.status, 200);
    assert.match(home.body, /Grafikprüfung · keine laufende Spielwelt/);
    assert.equal(home.headers["x-content-type-options"], "nosniff");
    assert.match(home.headers["content-security-policy"], /default-src 'self'/);
    assert.equal((await rawRequest(port, "/", { method: "HEAD" })).body, "");
    assert.equal((await rawRequest(port, "/", { method: "POST" })).status, 405);
    assert.equal((await rawRequest(port, "/", { headers: { host: "example.invalid" } })).status, 403);
    for (const path of ["/../AGENTS.md", "/%2e%2e/AGENTS.md", "/atlases/../prepared.json", "/prepared.json", "/manifest.json", "/sources/generation.json", "/atlases/undeclared.png"])
      assert.equal((await rawRequest(port, path)).status, 404, path);
    const release = await rawRequest(port, "/api/release");
    assert.equal(release.status, 200);
    const data = JSON.parse(release.body);
    assert.equal(data.schemaVersion, "conductor-art-preview/v1");
    assert.match(data.preparedSha256, /^[a-f0-9]{64}$/);
    for (const file of data.prepared.files) {
      const image = await rawRequest(port, `/${file.path}`);
      assert.equal(image.status, 200, file.path); assert.equal(image.headers["content-type"], "image/png");
    }
  } finally { await close(server); }
});

test("Edge reviews actual atlas images, motion, pixel zoom, keyboard and 320px layout", {
  skip: process.env.ART_PREVIEW_BROWSER_TEST !== "1" ? "Set ART_PREVIEW_BROWSER_TEST=1 for the installed Edge/Chromium proof." : false,
  timeout: 120_000,
}, async () => {
  const { chromium } = await import("../../apps/game-api/node_modules/playwright-core/index.mjs");
  const server = await startArtPreviewServer({ port: 0 });
  let browser;
  try { browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : process.platform === "win32" ? { channel: "msedge" } : {}),
  }); } catch (error) { await close(server); throw error; }
  const output = resolve(process.env.ART_PREVIEW_SCREENSHOT_DIR ?? resolve(ROOT, "work/art-atlas-preview"));
  const reportPath = resolve(process.env.ART_PREVIEW_REPORT_PATH ?? resolve(output, "browser-report.json"));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
  const errors = [], layouts = [], screenshots = [], origin = `http://127.0.0.1:${server.address().port}`;
  page.on("pageerror", (error) => errors.push(error.message));
  const layout = async (name) => {
    const result = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(result.scrollWidth <= result.width, `${name}: outer overflow ${JSON.stringify(result)}`);
    layouts.push({ name, ...result });
  };
  const screenshot = async (name) => {
    const bytes = await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
    screenshots.push({ file: `${name}.png`, sha256: createHash("sha256").update(bytes).digest("hex"), viewport: page.viewportSize() });
  };
  try {
    await mkdir(output, { recursive: true });
    await page.goto(origin); await page.locator("body[data-loaded=true]").waitFor();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".skip").evaluate((link) => link === document.activeElement && getComputedStyle(link).opacity === "1"), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(".skip").evaluate((link) => getComputedStyle(link).opacity), "0");
    const release = await (await page.request.get(`${origin}/api/release`)).json();
    assert.equal(release.prepared.assets.length, 172); assert.equal(release.prepared.animations.length, 60);
    for (const file of release.prepared.files) {
      const image = await page.request.get(`${origin}/${file.path}`);
      assert.equal(createHash("sha256").update(await image.body()).digest("hex"), file.sha256, file.id);
    }
    assert.equal(await page.locator("#gallery .asset-card").count(), 172);
    assert.equal(await page.locator("#gallery .missing-frame").count(), 0);
    assert.match(await page.locator("#file-count").textContent(), /6\/6 Atlasdateien geladen/);
    assert.equal(await page.locator("#motion").getAttribute("aria-pressed"), "false");
    await layout("desktop-scene");
    for (const [station, environment] of [["small", "rural"], ["medium", "suburban"], ["large", "urban"]]) {
      await page.locator("#station").selectOption(station); await page.locator("#environment").selectOption(environment);
      assert.equal(await page.locator("#scene").getAttribute("data-station"), station);
      assert.equal(await page.locator("#scene").getAttribute("data-environment"), environment);
      assert.equal(await page.locator("#scene").getAttribute("data-missing"), "0");
      await screenshot(`scene-${station}-${environment}-1x`);
    }
    await page.locator("#roof").check(); await page.locator("#platform-roof").check();
    assert.equal(await page.locator("#scene").getAttribute("data-missing"), "0");
    await screenshot("scene-roofs-1x");
    await page.locator("#roof").uncheck(); await page.locator("#platform-roof").uncheck();
    for (const zoom of [1, 2, 3, 4]) {
      await page.locator(`[data-zoom="${zoom}"]`).click();
      assert.deepEqual(await page.locator("#scene").evaluate((canvas) => ({ width: canvas.width, smoothing: canvas.getContext("2d").imageSmoothingEnabled })), { width: 960 * zoom, smoothing: false });
      await layout(`desktop-zoom-${zoom}`);
    }
    await page.locator('[data-zoom="2"]').click();
    await page.locator("#tab-scene").focus(); await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#tab-actors").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#actor-grid canvas").count(), 20);
    await page.locator("#pose").selectOption("walk");
    const first = page.locator("#actor-grid canvas").first();
    const initialFrame = await first.getAttribute("data-asset-id");
    await page.locator("#motion").click();
    await page.waitForFunction((initial) => document.querySelector("#actor-grid canvas").dataset.assetId !== initial, initialFrame);
    await page.locator("#motion").click();
    const paused = await first.getAttribute("data-asset-id");
    await page.waitForTimeout(600); assert.equal(await first.getAttribute("data-asset-id"), paused);
    await screenshot("actors-walk-paused-2x");
    await page.locator("#pose").selectOption("sitting"); await screenshot("actors-sitting-2x");
    await page.locator("#tab-gallery").click();
    await page.locator('[data-zoom="1"]').click(); await screenshot("gallery-complete-1x");
    await page.locator('[data-zoom="2"]').click();
    await page.locator("#category").selectOption("station");
    assert.equal(await page.locator("#gallery .asset-card").count(), 15);
    await screenshot("gallery-stations-2x");
    await page.locator("#category").selectOption("vehicle"); await page.locator(".asset-open").first().click();
    assert.equal(await page.locator("#asset-dialog").evaluate((dialog) => dialog.open), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#asset-dialog").evaluate((dialog) => dialog.open), false);
    await page.locator("#category").selectOption("all"); await page.locator("#search").fill("wheelchair");
    assert.equal(await page.locator("#gallery .asset-card").count(), 4);
    await page.locator("#search").fill("");
    await page.locator("#tab-evidence").click();
    assert.match(await page.locator("#evidence").textContent(), /keine Signatur/);
    await screenshot("release-evidence");

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of ["scene", "actors", "gallery", "evidence"]) {
        await page.locator(`#tab-${tab}`).click();
        for (const zoom of [1, 2, 3, 4]) {
          await page.locator(`[data-zoom="${zoom}"]`).click(); await layout(`mobile-${width}-${tab}-${zoom}x`);
        }
      }
      await page.locator("#tab-scene").click(); await page.locator('[data-zoom="1"]').click();
      await page.locator("#focus-train").click();
      assert.ok(await page.locator(".scene-viewport").evaluate((viewport) => viewport.scrollTop > 0 && viewport.scrollLeft > 0));
      await screenshot(`mobile-${width}-scene`);
      await page.locator("#tab-actors").click(); await screenshot(`mobile-${width}-actors`);
    }

    // An absent motif remains explicitly missing; no alternative art is substituted.
    await page.route("**/api/release", async (route) => {
      const data = structuredClone(release);
      data.prepared.assets = data.prepared.assets.filter((asset) => asset.id !== "vehicle.body");
      await route.fulfill({ json: data });
    });
    await page.locator("#reload").click();
    await page.waitForFunction(() => document.body.dataset.assetCount === "171");
    assert.equal(await page.locator('[data-asset-id="vehicle.body"] .missing-frame').count(), 1);
    assert.match(await page.locator("#scene-missing").textContent(), /vehicle.body/);
    assert.deepEqual(errors, []);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({
      schemaVersion: "art-atlas-browser-review/v1", browser: browser.version(), recordedAt: new Date().toISOString(),
      browserChannel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? "configured-executable" : process.platform === "win32" ? "msedge" : "chromium",
      preparedSha256: release.preparedSha256, observedManifestSha256: release.manifestSha256, observedManifestStatus: release.manifest?.status ?? null,
      assets: release.prepared.assets.length, animations: release.prepared.animations.length,
      files: release.prepared.files.map(({ id, sha256 }) => ({ id, sha256 })),
      proof: "Local graphics review only; no game world, M10 operations or release activation proof.",
      reducedMotionStartsPaused: true, pausePreservesFrame: true, missingMotifHasNoReplacement: true,
      declaredHashesVerifiedAgainstServedBytes: true,
      integerZooms: [1, 2, 3, 4], layouts, pageErrors: errors, screenshots,
    }, null, 2)}\n`);
  } finally { await browser.close(); await close(server); }
});
