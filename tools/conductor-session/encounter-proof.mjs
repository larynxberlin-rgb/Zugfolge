/** Actual DOM/API proof of conversation ownership, independent of local selection. */
import assert from "node:assert/strict";

export async function assertEncounterAttribution({ page, request, expectedPassengerKey, selectDifferent = false }) {
  const before = await request(), snapshot = before.snapshot;
  assert.ok(snapshot.activeEncounter);
  assert.equal(snapshot.activePassengerKey, expectedPassengerKey);
  const people = snapshot.passengers.passengers;
  const index = people.findIndex((person) => person.passengerKey === expectedPassengerKey && person.activity === "onboard");
  assert.ok(index >= 0);
  const label = await page.locator(".conductor-passenger").nth(index).innerText();
  const caption = `Gespräch mit ${label}`;
  await page.waitForFunction((text) => document.querySelector(".conductor-encounter-passenger")?.textContent === text, caption);
  let otherSelection = null;
  if (selectDifferent) {
    const other = people.findIndex((person) => person.passengerKey !== expectedPassengerKey && person.activity === "onboard");
    assert.ok(other >= 0);
    const button = page.locator(".conductor-passenger").nth(other);
    otherSelection = await button.innerText(); await button.click();
    assert.equal(await page.locator(".conductor-selected h3").innerText(), otherSelection);
    assert.equal(await page.locator(".conductor-encounter-passenger").innerText(), caption);
    assert.match(await page.locator(".conductor-encounter-selection").innerText(), /andere Person ausgewählt/u);
  }
  const after = await request();
  assert.equal(after.snapshot.activePassengerKey, expectedPassengerKey);
  assert.deepEqual(after.snapshot.activeEncounter, snapshot.activeEncounter);
  assert.deepEqual(after.snapshot.position, snapshot.position);
  const accessibility = await page.locator(".conductor-encounter").ariaSnapshot();
  assert.ok(accessibility.includes(caption));
  return { encounterId: snapshot.activeEncounter.encounterId, activePassengerKey: expectedPassengerKey,
    caption, otherSelection, snapshotHash: after.snapshot.snapshotHash, accessibility };
}
