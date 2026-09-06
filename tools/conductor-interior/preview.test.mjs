import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";
import { startInteriorPreviewServer } from "./server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const enabled = process.env.CONDUCTOR_INTERIOR_BROWSER_TEST === "1";

test("Echte M5-Innenräume im Browser begehen, Übergänge und Kollisionen nativ prüfen", { skip: !enabled, timeout: 360_000 }, async () => {
  const { createNativeInteriorPreviewBackend } = await import("./native-backend.mjs");
  const backend = await createNativeInteriorPreviewBackend();
  const server = await startInteriorPreviewServer({ port: 0, backend });
  const base = `http://127.0.0.1:${server.address().port}`;
  const screenshotDirectory = resolve(process.env.CONDUCTOR_INTERIOR_SCREENSHOT_DIR ?? resolve(ROOT, "docs/conductor-interior/screenshots"));
  const reportPath = resolve(process.env.CONDUCTOR_INTERIOR_REPORT_PATH ?? resolve(ROOT, "docs/conductor-interior/browser-report.json"));
  await mkdir(screenshotDirectory, { recursive: true }); await mkdir(dirname(reportPath), { recursive: true });
  const browserOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : process.platform === "win32" ? { channel: "msedge" } : {};
  const browser = await chromium.launch({ headless: true, ...browserOptions });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce" });
  const page = await context.newPage(), errors = [], movements = [], screenshots = [], results = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.url().endsWith("/movement")) movements.push(response.json()); });
  const catalog = await backend.listCases();
  const capture = async (name) => {
    const path = resolve(screenshotDirectory, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    screenshots.push({ name, file: `screenshots/${name}.png`, sha256: sha256(await readFile(path)), viewport: page.viewportSize(), state: await page.evaluate(() => window.interiorProofSummary) });
  };
  const ready = () => page.waitForFunction(() => ["ready", "blocked", "error"].includes(document.getElementById("main").dataset.state));
  const selectCase = async (id) => {
    await page.selectOption("#case", id);
    await page.waitForFunction((id) => window.interiorProofSummary.caseId === id && !document.getElementById("case").disabled, id);
    await ready();
  };
  const walkTo = async (nodeId) => {
    await page.selectOption("#destination", nodeId); await page.click("#walk");
    await page.waitForFunction((nodeId) => !document.getElementById("walk").disabled && window.interiorProofSummary.currentNodeId === nodeId, nodeId, { timeout: 100_000 });
    assert.match(await page.textContent("#movement"), /Ziel erreicht/);
  };
  try {
    await page.goto(base, { waitUntil: "networkidle" }); await ready();
    assert.equal(await page.getAttribute("#main", "data-state"), "ready", await page.textContent("#status"));
    const atlasFiles = [];
    for (const file of catalog.art.manifest.files) {
      const bytes = new Uint8Array(await (await fetch(`${base}/api/art/${file.id}`)).arrayBuffer());
      assert.equal(sha256(bytes), file.sha256);
      atlasFiles.push({ fileId: file.id, path: file.path, sha256: sha256(bytes), bytes: bytes.length });
    }
    let positive = 0, blocked = 0, stairs = 0, gangways = 0;
    for (const entry of catalog.cases) {
      const data = await backend.loadCase(entry.id);
      await selectCase(entry.id);
      if (data.issue) {
        blocked++; assert.equal(await page.getAttribute("#main", "data-state"), "blocked");
        for (const key of ["compilerOutputSetHash", "fleetStateHash", "authorityReleaseHash"]) {
          assert.match(data.evidence[key], /^[0-9a-f]{64}$/);
          assert.notEqual(data.evidence[key], catalog.evidence[key], `Der unabhängig kompilierte Negativfall benötigt seinen eigenen ${key}`);
        }
        assert.equal(await page.textContent("#blocked-code"), data.issue.code);
        assert.match(await page.textContent("#layout-subtitle"), /kein freigegebenes betretbares Layout/);
        assert.equal(await page.locator("#valid-layout").isVisible(), false);
        assert.equal((await page.evaluate(() => window.interiorProofSummary)).layoutHash, null);
        results.push({ caseId: entry.id, label: entry.label, issue: data.issue, evidence: data.evidence });
        await capture(`${entry.id}-blocked`); continue;
      }
      positive++;
      const layout = data.layout, summary = await page.evaluate(() => window.interiorProofSummary);
      assert.equal(summary.layoutHash, layout.layoutHash);
      assert.deepEqual(summary.capacity, layout.capacity);
      assert.equal(layout.passengerPlaces.length, layout.capacity.standardSeats + layout.capacity.premiumSeats + layout.capacity.standardStanding);
      await capture(`${entry.id}-entry`);
      const firstStair = layout.edges.find((edge) => edge.kind === "stair");
      if (firstStair) {
        const first = layout.nodes.find((node) => node.nodeId === firstStair.fromNodeId), second = layout.nodes.find((node) => node.nodeId === firstStair.toNodeId);
        const upper = first.point.deckId === "upper" ? first : second;
        const originalPoint = (await page.evaluate(() => window.interiorProofSummary)).currentPoint;
        await page.selectOption("#body", `${upper.point.vehicleId}/${upper.point.bodyId}`);
        await page.selectOption("#deck", "upper");
        assert.deepEqual((await page.evaluate(() => window.interiorProofSummary)).currentPoint, originalPoint, "Ansichtswechsel darf keine Figur teleportieren");
        await page.click("#follow");
        await page.check("#wheelchair");
        await page.selectOption("#destination", upper.nodeId); await page.click("#walk");
        await page.waitForFunction(() => !document.getElementById("walk").disabled);
        assert.match(await page.textContent("#movement"), /Weg abgelehnt/);
        assert.deepEqual((await page.evaluate(() => window.interiorProofSummary)).currentPoint, originalPoint);
        await page.uncheck("#wheelchair"); await walkTo(upper.nodeId);
        assert.equal((await page.evaluate(() => window.interiorProofSummary)).currentPoint.deckId, "upper");
        await capture(`${entry.id}-upper`);
        await page.click("#transition");
        await page.waitForFunction(() => !document.getElementById("transition").disabled && window.interiorProofSummary.currentPoint.deckId === "lower");
        stairs++; await capture(`${entry.id}-stairs`);
      }
      const lastBody = layout.vehicles.flatMap((vehicle) => vehicle.bodies).filter((body) => body.passengerAccessible).at(-1);
      const target = [...layout.interactions].reverse().map((item) => layout.nodes.find((node) => node.nodeId === item.nodeId)).find((node) => node.point.vehicleId === lastBody.vehicleId && node.point.bodyId === lastBody.bodyId);
      assert.ok(target);
      const before = (await page.evaluate(() => window.interiorProofSummary)).currentNodeId;
      const nativePath = await backend.findPath(entry.id, { expectedLayoutHash: layout.layoutHash, fromNodeId: before, toNodeId: target.nodeId, wheelchair: false });
      const crossedGangways = nativePath.edgeIds.filter((id) => layout.edges.find((edge) => edge.edgeId === id)?.kind === "gangway").length;
      await walkTo(target.nodeId); gangways += crossedGangways;
      await capture(`${entry.id}-walked`);
      await page.locator("summary").filter({ hasText: "Kollisionsprüfung" }).click(); await page.click("#collision");
      await page.waitForFunction(() => document.getElementById("main").dataset.collisionAllowed === "false");
      assert.match(await page.textContent("#collision-result"), /Kollision verhindert/);
      assert.equal((await page.evaluate(() => window.interiorProofSummary)).currentNodeId, target.nodeId);
      results.push({ caseId: entry.id, label: entry.label, binding: layout.binding, layoutHash: layout.layoutHash, capacity: layout.capacity, passengerPlaces: layout.passengerPlaces.length, specialBays: layout.specialBays.length, nativePath: { edgeCount: nativePath.edgeIds.length, lengthMm: nativePath.lengthMm, crossedGangways }, evidence: data.evidence, browserState: await page.evaluate(() => window.interiorProofSummary) });
    }
    assert.ok(positive >= 3, "Mindestens drei vollständige Konfigurationen"); assert.ok(blocked >= 1, "Fehlender Konfigurationsbeleg sichtbar");
    assert.ok(stairs > 0, "Doppelstocktreppe tatsächlich benutzt"); assert.ok(gangways > 0, "Wagenübergang tatsächlich begangen");
    await selectCase(catalog.cases.find((entry) => results.some((result) => result.caseId === entry.id && result.binding)) .id);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}px ohne äußeren horizontalen Überlauf`);
      await page.click('[data-zoom="2"]'); await page.click("#follow");
      await capture(`mobile-${width}`);
      const focus = page.locator("#viewport"); await focus.focus();
      assert.equal(await focus.evaluate((node) => document.activeElement === node), true);
      assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    }
    assert.deepEqual(errors, []);
    const movementResults = await Promise.all(movements);
    assert.ok(movementResults.some((result) => result.allowed === false)); assert.ok(movementResults.some((result) => result.allowed === true));
    await writeFile(reportPath, `${JSON.stringify({ schemaVersion: "conductor-interior-browser-report/v1", executedAt: new Date().toISOString(), browser: { engine: "chromium", channel: browserOptions.channel ?? "configured-chromium", version: browser.version(), platform: process.platform }, source: "Echte M5-Initialisierung und committed DB-Prüfung mit fiktiven vollständigen Spielkonfigurationen; native Rust-Geometrie und Bewegungsprüfung.", scope: { productionCatalog: false, productionArtSignature: false, persistentConductorSession: false, trainRunBinding: false }, artManifestSha256: catalog.art.manifestSha256, artVerification: catalog.art.verification, atlasFiles, results, checks: { positiveCases: positive, blockedCases: blocked, stairTransitions: stairs, gangways, approvedMovements: movementResults.filter((result) => result.allowed).length, blockedMovements: movementResults.filter((result) => result.allowed === false).length, mobileWidths: [390, 320], pageErrors: errors }, screenshots }, null, 2)}\n`);
  } finally {
    await browser.close(); await new Promise((done) => { server.closeAllConnections(); server.close(done); }); await backend.close();
  }
});
