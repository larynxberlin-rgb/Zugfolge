import { artifact, outputPath, browserLaunchOptions } from "./paths.mjs";
// All gameplay actions use the delivered UI. The diagnostic getter is read-only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const html = resolve(process.env.PRACTICE_BROWSER_HTML ?? artifact);
const out = resolve(process.env.PRACTICE_BROWSER_OUTPUT ?? outputPath("practice"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const htmlSha256 = sha(await readFile(html));
const qa = JSON.parse(await readFile(resolve(root, "data/practice-qa.json"), "utf8"));
await mkdir(out, { recursive: true });
const browser = await chromium.launch(await browserLaunchOptions());
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, offline: true });
const page = await context.newPage(), pageErrors = [], network = [], checks = [], screenshots = [];
page.setDefaultTimeout(30_000);
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => { if (/^(?:https?|wss?):/u.test(request.url())) network.push(request.url()); });
const snapshot = () => page.evaluate(() => window.__zugfolgeOfflineDemo.snapshot());
const errors = () => page.locator(".demo-error:visible,.game-error:visible").allTextContents();
const log = (name, detail = {}) => { checks.push({ name, ...detail }); process.stdout.write(JSON.stringify(checks.at(-1)) + "\n"); };
async function waitState(predicate, timeout = 90_000) {
  const until = Date.now() + timeout;
  do {
    const state = await snapshot();
    assert.deepEqual(await errors(), []); assert.deepEqual(pageErrors, []);
    if (predicate(state)) return state;
    await page.waitForTimeout(250);
  } while (Date.now() < until);
  throw new Error("The actual UI did not reach the required native state before the bounded timeout.");
}
async function ready() {
  await page.waitForFunction(() => document.documentElement.dataset.offlineReady === "true"
    || !document.querySelector("#demo-error")?.hidden);
  assert.deepEqual(await errors(), []);
  assert.equal(await page.evaluate(() => window.__zugfolgeOfflineDemo.metadata.fixtureHash), qa.fixtureHash);
}
async function capture(file) {
  const bytes = await page.screenshot({ path: resolve(out, file), fullPage: true });
  screenshots.push({ file, sha256: sha(bytes) });
}
async function option(id) {
  // Native availability and time gating remain on the real visible button.
  await page.locator(`.game-answers button[data-option-id="${id}"]`).click({ timeout: 30_000 });
}
async function bubble(target, state) {
  await page.locator(".game-speech:visible").waitFor();
  assert.equal(state.snapshot.activePassengerKey, target.passengerKey);
  assert.equal(await page.getByTestId("game-passenger-text").innerText(), state.snapshot.activeEncounter.passengerText);
  assert.equal(await page.locator(".game-speech").getAttribute("data-passenger-key"), target.passengerKey);
  const measured = await page.evaluate(({ person, position, body }) => {
    const canvas = document.querySelector(".game-stage canvas"), speech = document.querySelector(".game-speech");
    const area = canvas.getBoundingClientRect(), box = speech.getBoundingClientRect(), scale = area.width / canvas.width;
    const half = canvas.width / 2, width = body.lengthMm * .032;
    const center = width < canvas.width ? width / 2 : Math.max(half - 20, Math.min(width - half + 20, position.xMm * .032));
    const tx = Math.round(half - center), ty = Math.round(canvas.height * .54 - body.widthMm * .032 / 2);
    const anchorX = area.left + Math.round(tx + person.xMm * .032) * scale;
    const anchorY = area.top + Math.round(ty + person.yMm * .032) * scale;
    const tail = box.left + parseFloat(getComputedStyle(speech).getPropertyValue("--speech-tail"));
    return { inside: box.left >= area.left && box.right <= area.right && box.top >= area.top && box.bottom <= area.bottom,
      tailDistanceX: Math.abs(tail - anchorX), headGap: anchorY - box.bottom,
      text: speech.textContent, canvasDeck: canvas.dataset.deck, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  }, { person: state.snapshot.passengers.passengers.find((person) => person.passengerKey === target.passengerKey),
    position: state.snapshot.position, body: state.layout.vehicles.find((vehicle) => vehicle.vehicleId === target.position.vehicleId)
      .bodies.find((body) => body.bodyId === target.position.bodyId) });
  assert.equal(measured.inside, true, "The speech bubble must stay in the play area.");
  assert.ok(measured.tailDistanceX <= 32, JSON.stringify(measured));
  assert.ok(measured.headGap >= 0 && measured.headGap <= 180, JSON.stringify(measured));
  assert.equal(measured.canvasDeck, target.position.deckId);
  assert.ok(measured.scrollWidth <= measured.width);
  return measured;
}
async function closeFinishedConversation() {
  const next = page.getByTestId("game-continue");
  if (await next.isVisible()) {
    await next.click();
    await page.getByTestId("game-case-result").waitFor({ state: "hidden" });
    log("visible-continue-dismissed-result");
  }
}
async function visibleResult(caseId, claim, paid) {
  const card = page.getByTestId("game-case-result");
  await card.waitFor({ state: "visible" });
  await page.waitForFunction(({ caseId, claim, paid }) => {
    const card = document.querySelector('[data-testid="game-case-result"]');
    return card?.getAttribute("data-case-id") === caseId && card.textContent.includes(`Forderung: ${claim}`)
      && card.textContent.includes(`Gezahlt: ${paid}`) && card.getBoundingClientRect().height > 0;
  }, { caseId, claim, paid });
  const text = await card.innerText();
  log("visible-in-game-result", { caseId, text });
  return text;
}
let passed = false;
try {
  await page.goto(pathToFileURL(html).href, { waitUntil: "load" }); await ready();
  await page.getByTestId("demo-start").click();
  await page.locator(".game-stage canvas").waitFor();
  const started = await snapshot();
  assert.equal(started.snapshot.passengers.passengers.length, qa.passengers);
  log("actual-fixture-and-40-passengers", { fixtureHash: qa.fixtureHash, passengers: qa.passengers });
  let regularCaseId, provisionalCaseId;
  for (const [index, target] of qa.targets.entries()) {
    await closeFinishedConversation();
    const before = (await snapshot()).snapshot.position;
    await page.getByTestId("game-practice").selectOption(target.passengerKey);
    let state = await waitState((value) => value.snapshot.activePassengerKey === target.passengerKey
      && value.snapshot.activeEncounter?.status === "active");
    const interactionPoint = state.layout.nodes.find((node) => node.nodeId === target.targetNodeId)?.point;
    assert.ok(interactionPoint);
    assert.deepEqual(state.snapshot.position, interactionPoint, "The UI must reach the actual native interaction node.");
    if (JSON.stringify(before) !== JSON.stringify(interactionPoint)) assert.notDeepEqual(state.snapshot.position, before);
    assert.equal(state.snapshot.position.bodyId, target.position.bodyId);
    assert.equal(state.snapshot.position.deckId, target.position.deckId);
    assert.equal(state.snapshot.activeEncounter.hints.documentStatus, "unchecked");
    const encounterId = state.snapshot.activeEncounter.encounterId;
    const speech = await bubble(target, state);
    await option("check");
    state = await waitState((value) => value.snapshot.activePassengerKey === target.passengerKey
      && value.snapshot.activeEncounter?.hints.documentStatus !== "unchecked");
    assert.deepEqual(state.snapshot.activeEncounter.hints, target.expectedEvidence);
    log("visible-walk-and-document-check", { label: target.label, from: before, to: state.snapshot.position,
      encounterId, speech, evidence: state.snapshot.activeEncounter.hints });
    if (index === 0) {
      assert.equal(await page.locator('.game-answers button[data-option-id="regular"],.game-answers button[data-option-id="provisional"],.game-answers button[data-option-id="police"]').count(), 0);
      // Pause and restore the actual active conversation through ordinary UI.
      await page.getByRole("button", { name: "Zur Demo zurückkehren und pausieren", exact: true }).click();
      await page.locator("dialog.game-mode").waitFor({ state: "detached" });
      const saved = await snapshot();
      await page.reload({ waitUntil: "load" }); await ready();
      const restored = await snapshot();
      assert.deepEqual(restored.snapshot.position, saved.snapshot.position);
      assert.deepEqual(restored.snapshot.activeEncounter, saved.snapshot.activeEncounter);
      assert.equal(restored.snapshot.activePassengerKey, target.passengerKey);
      assert.equal(await page.evaluate(() => window.__zugfolgeOfflineDemo.persistence.restored), true);
      await page.getByTestId("demo-start").click();
      state = await waitState((value) => value.snapshot.status === "active" && value.snapshot.activePassengerKey === target.passengerKey);
      await bubble(target, state); log("active-conversation-restored-through-ui");
      await option("close");
      state = await waitState((value) => value.control?.cases.some((row) => row.encounterId === encounterId && row.status === "closed_without_claim"));
      assert.equal(state.control.cases.find((row) => row.encounterId === encounterId).claimKind, null);
    } else {
      const kind = index === 1 ? "regular" : "provisional";
      await option(kind);
      state = await waitState((value) => value.control?.cases.some((row) => row.encounterId === encounterId && row.claimKind === kind));
      const opened = state.control.cases.find((row) => row.encounterId === encounterId);
      assert.equal(opened.claimCents, "6000");
      assert.equal(opened.paidCents, "0");
      if (kind === "regular") regularCaseId = opened.caseId; else provisionalCaseId = opened.caseId;
      await visibleResult(opened.caseId, "60,00", "0,00");
      await capture(`exercise-${index + 1}-actual-claim.png`);
      state = await waitState((value) => value.control.cases.some((row) => row.caseId === opened.caseId && row.paidCents === "6000"), 30_000);
      await visibleResult(opened.caseId, "60,00", "60,00");
      await capture(`exercise-${index + 1}-actual-payment.png`);
      log("actual-ui-claim-and-payment", { label: target.label, case: state.control.cases.find((row) => row.caseId === opened.caseId) });
    }
  }
  let state = await waitState((value) => value.control.cases.some((row) => row.caseId === provisionalCaseId && row.claimCents === "700" && row.paidCents === "700"), 35_000);
  assert.match(await visibleResult(provisionalCaseId, "7,00", "7,00"), /Nachweisfrist/u);
  await capture("exercise-3-actual-reduction.png");
  log("actual-later-proof-reduction", { case: state.control.cases.find((row) => row.caseId === provisionalCaseId) });
  await page.getByTestId("game-report").click();
  const report = page.locator("dialog.conductor-report"); await report.waitFor();
  await report.getByRole("button", { name: "Bericht aktualisieren", exact: true }).click();
  const regular = report.locator(`details[data-case-id="${regularCaseId}"]`);
  await regular.locator("summary").click();
  assert.match(await regular.innerText(), /Reguläre Forderung: 60,00/u);
  assert.match(await regular.innerText(), /Gezahlt: 60,00/u);
  const provisional = report.locator(`details[data-case-id="${provisionalCaseId}"]`);
  await provisional.locator("summary").click();
  assert.match(await provisional.innerText(), /Vorläufige Forderung: 7,00/u);
  assert.match(await provisional.innerText(), /Gezahlt: 7,00/u);
  assert.match(await provisional.innerText(), /Nachweisfrist/u);
  await capture("three-exercises-native-report.png");
  await report.getByRole("button", { name: "Zurück", exact: true }).click();
  await closeFinishedConversation();
  await page.getByRole("button", { name: "Zur Demo zurückkehren und pausieren", exact: true }).click();
  await page.locator("dialog.game-mode").waitFor({ state: "detached" });
  const previousSessionId = (await snapshot()).snapshot.sessionId;
  await page.getByTestId("demo-reset").click();
  // Reset intentionally removes the old native session before opening its
  // successor. The renderer is created only after start_session returns; await
  // this visible readiness boundary rather than reading the intermediate void.
  await page.locator("dialog.game-mode[open] .game-stage canvas").waitFor();
  state = await waitState((value) => value.snapshot.status === "active"
    && typeof value.snapshot.sessionId === "string" && value.snapshot.sessionId.length > 0
    && value.snapshot.sessionId !== previousSessionId);
  assert.equal(state.control.cases.length, 0); assert.equal(state.snapshot.activeEncounter, null);
  log("actual-new-practice-session", { emptyCases: true });
  assert.deepEqual(await errors(), []); assert.deepEqual(pageErrors, []); assert.deepEqual(network, []);
  passed = true;
} catch (error) {
  await capture("practice-failure.png").catch(() => {});
  await writeFile(resolve(out, "practice-failure.txt"), `${error.stack}\n${JSON.stringify(await errors())}\n`);
  throw error;
} finally {
  await writeFile(resolve(out, "practice-browser-report.json"), JSON.stringify({ schemaVersion: "conductor-offline-practice-browser/v1",
    testOnly: true, passed, htmlSha256, fixtureHash: qa.fixtureHash, offline: true,
    allGameplayActionsThroughVisibleUi: true, diagnosticAccess: "read-only", checks, screenshots, pageErrors, network }, null, 2) + "\n");
  await browser.close();
}
