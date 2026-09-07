import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";
import { startConductorSessionBrowserBackend } from "./native-backend.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("gemeinsamer Zugdetail-Einstieg prüft echte Availability, Gründe, Start, Resume und Rückkehr", {
  skip: process.env.CONDUCTOR_ENTRY_BROWSER_TEST !== "1", timeout: 300_000,
}, async () => {
  const backend = await startConductorSessionBrowserBackend({ entryOnly: true });
  const output = resolve(process.env.CONDUCTOR_SESSION_SCREENSHOT_DIR ?? resolve(ROOT, "outputs/M15-Sitzung/screenshots"));
  const reportPath = resolve(process.env.CONDUCTOR_ENTRY_REPORT_PATH ?? resolve(output, "../entry-browser-report.json"));
  const screenshots = [], pageErrors = [], availability = [], commands = [];
  let browser, page;
  try {
    await mkdir(output, { recursive: true }); await mkdir(dirname(reportPath), { recursive: true });
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : process.platform === "win32" ? { channel: "msedge" } : {}) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(60_000); page.on("pageerror", (error) => pageErrors.push(error.message));
    const endpoint = `${new URL(backend.url).origin}${backend.route}`;
    const headers = { authorization: `Bearer ${backend.token}` };
    const shot = async (file) => { const bytes = await page.screenshot({ path: resolve(output, file), fullPage: true });
      screenshots.push({ file, sha256: sha(bytes), viewport: page.viewportSize() }); };
    const snapshot = async () => { const response = await page.request.get(`${endpoint}/snapshot`, { headers });
      assert.equal(response.status(), 200); return response.json(); };
    const entry = () => page.locator(".conductor-entry").getByRole("button").first();
    const availableResponse = () => page.waitForResponse((response) => response.request().method() === "GET"
      && response.url().endsWith("/conductor-sessions"));
    const captureAvailability = async (response) => { const body = await response.json();
      availability.push({ path: new URL(response.url()).pathname, status: response.status(), body }); return body; };
    page.on("response", async (response) => {
      if (response.request().method() !== "POST" || !response.url().endsWith("/conductor-sessions")) return;
      const input = response.request().postDataJSON(), body = await response.json();
      commands.push({ status: response.status(), action: input.action.type, sessionId: body.snapshot?.sessionId,
        revision: body.snapshot?.revision, stateHash: body.snapshot?.snapshotHash });
    });

    // Verzögerter echter Request: kein ersetzter HTTP-Status und keine erfundene Antwort.
    let releaseRequest;
    const held = new Promise((resolveRequest) => { releaseRequest = resolveRequest; });
    await page.route(endpoint, async (route) => { await held; await route.continue(); });
    const pending = availableResponse(); await page.goto(backend.url);
    await entry().waitFor(); assert.equal(await entry().isDisabled(), true);
    assert.equal(await page.locator(".conductor-entry [role=status]").innerText(), "Verfügbarkeit der Fahrt wird geprüft …");
    releaseRequest(); const initialAvailability = await captureAvailability(await pending);
    await page.unroute(endpoint);
    assert.equal(initialAvailability.available, true); assert.equal(initialAvailability.sessionId, null);
    await entry().isEnabled(); await entry().click();
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl");
    const initial = await snapshot(), context = await page.locator("#entry-detail").evaluate((element) => ({ dataset: { ...element.dataset },
      train: element.querySelector("h2").textContent, context: element.querySelector("p").textContent }));
    assert.equal(initial.snapshot.status, "active"); assert.equal(initial.snapshot.passengers.passengers.length, 160);
    assert.equal(await page.locator("#conductor-title").innerText(), context.train);
    assert.equal(await page.locator(".conductor-context").innerText(), context.context);
    const originalUrl = page.url(); await shot("entry-01-native-start.png");
    await page.getByRole("button", { name: "Zur Karte", exact: true }).click();
    await page.locator(".conductor-mode").waitFor({ state: "detached" });
    const detached = await snapshot(); assert.equal(detached.snapshot.status, "detached");
    assert.equal(detached.snapshot.sessionId, initial.snapshot.sessionId);
    assert.equal(await entry().evaluate((element) => element === document.activeElement), true);
    assert.equal(page.url(), originalUrl);
    assert.deepEqual(await page.locator("#entry-detail").evaluate((element) => ({ dataset: { ...element.dataset },
      train: element.querySelector("h2").textContent, context: element.querySelector("p").textContent })), context);
    await shot("entry-02-return-context.png");

    const resumeResponse = availableResponse(); await page.reload();
    const resumeAvailability = await captureAvailability(await resumeResponse);
    assert.equal(resumeAvailability.sessionId, initial.snapshot.sessionId);
    await page.getByRole("button", { name: "Schaffnersitzung fortsetzen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.renderer === "webgl");
    const resumed = await snapshot(); assert.equal(resumed.snapshot.status, "active");
    assert.equal(resumed.snapshot.sessionId, initial.snapshot.sessionId);
    assert.deepEqual(resumed.snapshot.position, initial.snapshot.position);
    await shot("entry-03-native-resume.png");
    await page.getByRole("button", { name: "Zugfolge – zur LiveMap", exact: true }).click();
    await page.locator(".conductor-mode").waitFor({ state: "detached" });
    assert.equal(await entry().evaluate((element) => element === document.activeElement), true);

    const rejections = [
      { hash: "trainRunId=unmaterialized-entry-proof", status: 409, code: "conductor_train_unavailable", image: "entry-04-missing-actual-train.png" },
      { hash: "operatorId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: 403, code: "conductor_access_denied", image: "entry-05-other-operator.png" },
    ];
    for (const rejected of rejections) {
      await page.goto("about:blank"); const response = availableResponse(); await page.goto(`${backend.url}#${rejected.hash}`);
      const actualResponse = await response, body = await captureAvailability(actualResponse);
      assert.equal(actualResponse.status(), rejected.status); assert.equal(body.code, rejected.code);
      await page.waitForFunction((message) => document.querySelector(".conductor-entry [role=status]")?.textContent === message, body.error);
      assert.equal(await entry().isDisabled(), true); assert.equal(await page.locator(".conductor-mode").count(), 0);
      await shot(rejected.image);
    }

    await page.goto("about:blank");
    let releaseStale;
    const staleGate = new Promise((resolveRequest) => { releaseStale = resolveRequest; });
    await page.route(endpoint, async (route) => { await staleGate; await route.continue(); });
    const staleResponse = availableResponse(); await page.goto(backend.url); await entry().waitFor();
    await page.getByRole("button", { name: "Auswahl verlassen", exact: true }).click();
    releaseStale(); assert.equal((await staleResponse).status(), 200); await page.unroute(endpoint);
    await page.waitForTimeout(100);
    assert.equal(await entry().isDisabled(), true);
    assert.equal(await page.locator("#entry-detail").getAttribute("data-selection"), "left");
    assert.ok(commands.some((row) => row.status === 200 && row.action === "start_session"));
    assert.ok(commands.some((row) => row.status === 200 && row.action === "detach_session"));
    assert.ok(commands.some((row) => row.status === 200 && row.action === "resume_session"));
    assert.deepEqual(pageErrors, []);
    await writeFile(reportPath, `${JSON.stringify({ schemaVersion: "conductor-entry-browser-proof/v1", testOnly: true,
      browser: browser.version(), evidence: backend.evidence, availability, commands, context, sessionId: initial.snapshot.sessionId,
      originalPosition: initial.snapshot.position, resumedPosition: resumed.snapshot.position, returnFocusPreserved: true,
      returnUrlPreserved: true, staleSelectionRemainedDisabled: true, screenshots, pageErrors,
      limits: ["Originale gemeinsame Zugdetailkomponente mit echten API-Antworten; keine nachgebildete Karte.",
        "Fiktive Originalinfrastruktur und M5-Spielkonfiguration; temporäre Testsignaturen, keine produktive Freigabe."] }, null, 2)}\n`);
    console.log(JSON.stringify({ reportPath, screenshots: screenshots.length, sessionId: initial.snapshot.sessionId }));
  } finally { await browser?.close(); await backend.close(); }
});
