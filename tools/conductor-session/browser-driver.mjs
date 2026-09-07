/** Shared proof driver: real production DOM, authorized HTTP and native movement only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const samePoint = (a, b) => ["vehicleId", "bodyId", "deckId", "xMm", "yMm"].every((key) => a[key] === b[key]);
export function operationalEventTimes(world) {
  return [...["scheduledMotionEnds", "scheduledContinuationDue", "scheduledPassengerDepartures"].flatMap((key) => world[key] ?? []),
    ...(world.fareControlState?.scheduled ?? [])].map((row) => row.atMs).filter(Number.isSafeInteger);
}
export function createConductorProofDriver({ backend, page, output, screenshots = [], accessibilityChecks = [], errors = [], commandResponses = [], requestFailures = [] }) {
  page.setDefaultTimeout(60000); page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    if (response.ok() || !response.url().includes("conductor-sessions")) return;
    requestFailures.push({ method: response.request().method(), path: new URL(response.url()).pathname,
      status: response.status(), body: await response.text().catch(() => "unavailable") });
    if (requestFailures.length > 40) requestFailures.shift();
  });
  page.on("response", async (response) => {
    if (!response.url().includes("conductor-sessions/events") || !response.ok()) return;
    await response.finished().catch(() => {});
    const body = await response.text().catch(() => "");
    for (const match of body.matchAll(/event: unavailable\ndata: ([^\n]+)/gu)) {
      requestFailures.push({ method: "SSE", path: new URL(response.url()).pathname, status: response.status(), body: match[1] });
      if (requestFailures.length > 40) requestFailures.shift();
    }
  });
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || !response.url().includes("conductor-sessions")) return;
    const text = await response.text().catch(() => "unavailable");
    let value; try { value = JSON.parse(text); } catch { value = { code: "non_json_response" }; }
    commandResponses.push({ status: response.status(), command: response.request().postDataJSON(),
      result: response.ok() ? { revision: value.snapshot?.revision, position: value.snapshot?.position } : value });
    if (commandResponses.length > 40) commandResponses.shift();
  });
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
  const historyRequest = async () => {
    const response = await page.request.get(`${new URL(backend.url).origin}${backend.route}/report`, { headers: { authorization: `Bearer ${backend.token}` } });
    assert.equal(response.status(), 200); const envelope = await response.json();
    assert.equal(envelope.schemaVersion, "conductor-report/v1");
    assert.doesNotMatch(JSON.stringify(envelope.control), /"fareFact"|"passengerKey"|"seedHash"|"responseAfterActivation"|"identityConfirmed"/u);
    return envelope.control;
  };
  const reportReady = async () => page.waitForFunction(() => {
    const dialog = document.querySelector(".conductor-report");
    const refresh = [...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Bericht aktualisieren");
    return dialog?.querySelector("[role=status]")?.textContent === "Letzter bestätigter Abrechnungsstand." && refresh && !refresh.disabled;
  });
  const idle = async () => {
    await page.waitForFunction(() => !document.querySelector(".conductor-status")?.textContent.includes("wird bestätigt"));
    assert.equal(await page.locator(".conductor-problem").isVisible(), false, await page.locator(".conductor-problem").textContent());
  };
  const tap = async (target) => {
    assert.ok(await page.evaluate(() => navigator.maxTouchPoints > 0));
    await target.scrollIntoViewIfNeeded(); const box = await target.boundingBox(); assert.ok(box);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  };
  const option = async (id, confirmation = false, touch = false) => {
    const before = await request(), encounter = before.snapshot.activeEncounter;
    assert.ok(encounter);
    if (encounter.availableAtMs > backend.fixture.clock.nowMs) {
      await backend.advance(encounter.availableAtMs - backend.fixture.clock.nowMs); await page.waitForTimeout(1200);
    }
    const current = await request(), choice = current.snapshot.activeEncounter.options.find((row) => row.optionId === id);
    assert.ok(choice, `Actual checked dialogue must offer ${id}`);
    const button = page.getByRole("button", { name: `${choice.text} · ${choice.timeCostMs / 1000} s`, exact: true });
    if (touch) await tap(button); else await button.click();
    if (confirmation) {
      const confirm = page.locator(".conductor-confirm"); await confirm.waitFor();
      assert.equal(await confirm.locator(".conductor-confirm-train").innerText(), await page.locator("#conductor-title").innerText());
      assert.equal(await confirm.getByRole("button", { name: "Abbrechen", exact: true }).evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press("Shift+Tab");
      assert.equal(await confirm.evaluate((element) => element.contains(document.activeElement)), true);
      await confirm.getByRole("button", { name: "Bestätigen", exact: true }).click();
    }
    await idle(); return request();
  };
  const assertContext = async () => {
    const world = await backend.fixture.db.query.worlds.findFirst({ where: (row, { eq }) => eq(row.id, backend.fixture.access.worldId) });
    const operator = await backend.fixture.db.query.operators.findFirst({ where: (row, { eq, and }) => and(eq(row.worldId, backend.fixture.access.worldId), eq(row.id, backend.fixture.access.operatorId)) });
    assert.ok(world && operator);
    assert.equal(await page.locator(".conductor-context").innerText(), `${world.name} · ${operator.name}`);
    assert.equal(await page.getByRole("button", { name: "Zugfolge – zur LiveMap", exact: true }).locator(".zf-brand__mark").count(), 1);
  };
  const walkToPassenger = async (passengerKey, label) => {
    let current = await request();
    const index = current.snapshot.passengers.passengers.findIndex((person) => person.passengerKey === passengerKey && person.activity === "onboard");
    assert.ok(index >= 0); await page.locator(".conductor-passenger").nth(index).click();
    const person = current.snapshot.passengers.passengers[index];
    const targetId = person.spaceNeeds === "wheelchair" ? person.spaceId : person.placeId;
    const interaction = current.layout.interactions.find((row) => row.targetId === targetId);
    assert.ok(interaction);
    const target = current.layout.nodes.find((row) => row.nodeId === interaction.nodeId)?.point;
    assert.ok(target);
    const atTarget = (position) => ["vehicleId", "bodyId", "deckId", "xMm", "yMm"].every((key) => position[key] === target[key]);
    if (!atTarget(current.snapshot.position)) {
      await page.getByRole("button", { name: "Zum Fahrgast gehen", exact: true }).click();
      for (let step = 0; step < 140 && !atTarget(current.snapshot.position); step++) {
        await backend.advance(1500); await page.waitForTimeout(800); current = await request();
        if (step % 20 === 0) console.log(`Control path ${label}: step ${step}, ${JSON.stringify(current.snapshot.position)}`);
        assert.equal(await page.locator(".conductor-problem").isVisible(), false, await page.locator(".conductor-problem").textContent());
      }
      assert.equal(atTarget(current.snapshot.position), true, `Actual native path did not reach ${label}`);
      await page.getByRole("button", { name: "Weg abbrechen", exact: true }).click();
    }
    return current;
  };
  const assertAccessibility = async (checked, label) => {
    const publicEncounter = checked.snapshot.activeEncounter;
    const encounterAccessibility = await page.locator(".conductor-encounter").ariaSnapshot();
    const statusAccessibility = await page.locator(".conductor-status").ariaSnapshot();
    assert.match(encounterAccessibility, /region "Fahrkartenkontrolle"/u);
    const containsPublicText = (text) => encounterAccessibility.includes(text)
      || encounterAccessibility.includes(JSON.stringify(text).slice(1, -1));
    assert.ok(containsPublicText(publicEncounter.passengerText), "The actual public speech must be present in the accessibility tree");
    for (const choice of publicEncounter.options) {
      assert.ok(containsPublicText(`${choice.text} · ${choice.timeCostMs / 1000} s`), "Every actual offered answer must be accessible");
    }
    assert.match(encounterAccessibility, /button/u);
    assert.ok(containsPublicText({ verified_valid: "Gültiger Nachweis bestätigt", verified_invalid: "Ungültiger Nachweis bestätigt",
      not_presentable: "Nachweis derzeit nicht vorzeigbar" }[publicEncounter.hints.documentStatus]));
    assert.match(statusAccessibility, /status/u); assert.match(statusAccessibility, /Fahrgäste an Bord/u);
    assert.doesNotMatch(`${encounterAccessibility}\n${statusAccessibility}`, /fareFact|passengerKey|ownerRef|seedHash|inspectionPolicy|identityConfirmed/u);
    accessibilityChecks.push({ scenario: label, encounter: encounterAccessibility, status: statusAccessibility });
  };
  const leaseActivity = [];
  const advanceKeepingSession = async (atMs) => {
    assert.ok(Number.isSafeInteger(atMs) && atMs >= backend.fixture.clock.nowMs);
    while (backend.fixture.clock.nowMs < atMs) {
      let current = await request(); assert.equal(current.snapshot.status, "active");
      const boundary = atMs < current.snapshot.leaseUntilMs - 2000 ? atMs : current.snapshot.leaseUntilMs - 10_000;
      if (boundary > backend.fixture.clock.nowMs) await backend.advance(boundary - backend.fixture.clock.nowMs);
      if (backend.fixture.clock.nowMs === atMs) return;
      const reportWasOpen = await page.locator(".conductor-report").isVisible();
      if (reportWasOpen) await page.locator(".conductor-report").getByRole("button", { name: "Zurück", exact: true }).click();
      current = await request(); const before = current.snapshot;
      const delta = [500, -500].find((x) => backend.fixture.runtimes.interior.movement({
        schemaVersion: "conductor-interior-movement-input/v1", layout: current.layout, expectedLayoutHash: current.layout.layoutHash,
        from: before.position, to: { ...before.position, xMm: before.position.xMm + x }, transitionEdgeId: null, wheelchair: false }).allowed);
      assert.ok(delta !== undefined, "The actual player position needs a real nearby walking segment");
      const direction = delta > 0 ? "→" : "←", reverse = delta > 0 ? "←" : "→";
      await page.getByRole("button", { name: `Gehen ${direction}`, exact: true }).click(); await idle();
      const away = (await request()).snapshot;
      assert.deepEqual(away.position, { ...before.position, xMm: before.position.xMm + delta });
      assert.ok(away.leaseUntilMs > before.leaseUntilMs);
      // Real elapsed simulation time pays the second movement command's
      // interval/budget; neither a state edit nor a synthetic heartbeat.
      assert.ok(atMs - backend.fixture.clock.nowMs >= 1000, "Lease care must not skip the requested native event boundary");
      await backend.advance(1000);
      await page.getByRole("button", { name: `Gehen ${reverse}`, exact: true }).click(); await idle();
      const returned = (await request()).snapshot;
      assert.deepEqual(returned.position, before.position);
      leaseActivity.push({ atMs: before.nowMs, sessionId: before.sessionId, before: before.position, away: away.position,
        returned: returned.position, previousLeaseUntilMs: before.leaseUntilMs, renewedLeaseUntilMs: returned.leaseUntilMs });
      if (reportWasOpen) { await page.getByRole("button", { name: "Kontrollbericht", exact: true }).click(); await reportReady(); }
    }
  };
  return { request, shot, historyRequest, reportReady, idle, tap, option, walkToPassenger, assertAccessibility, assertContext,
    advanceKeepingSession, leaseActivity, screenshots, accessibilityChecks, errors, commandResponses, requestFailures };
}
