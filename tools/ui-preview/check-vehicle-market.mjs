import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const origin = process.env.UI_PREVIEW_ORIGIN ?? "http://127.0.0.1:4173";
const output = fileURLToPath(new URL("../../docs/ui-redesign/screenshots/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : process.platform === "win32" ? { channel: "msedge" } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const layouts = [];
const errors = [];
const checks = [];
page.on("pageerror", error => errors.push(error.message));
async function layout(screen, width) {
  const result = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
  layouts.push({ screen, viewport: width, ...result });
  assert.ok(result.scrollWidth <= result.width + 1, `${screen}/${width}: horizontal overflow`);
  assert.ok(result.scrollHeight <= result.height + 1, `${screen}/${width}: document overflow`);
}
try {
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await page.goto(`${origin}/?screen=markets&qaWidth=${width}#vehicle-market`);
    await page.locator('#tab-vehicle-market[aria-selected="true"]').waitFor();
    assert.equal(await page.locator(".market-item:visible").count(), 2);
    await layout("vehicle-market", width);
    if (width === 1440) await page.screenshot({ path: `${output}/m12-vehicles.png` });
    await page.locator("#m12-market-type").selectOption("rental");
    assert.equal(await page.locator(".market-item:visible").count(), 1);
    assert.match(await page.locator(".market-item:visible").innerText(), /Für dich reserviert/i);
    assert.match(await page.locator(".market-item:visible").innerText(), /Gesamtmiete/);
    await page.locator("#m12-market-type").selectOption("all");
    await page.locator("#m12-market-query").fill("442");
    await page.locator("#m12-market-query").dispatchEvent("change");
    assert.equal(await page.locator(".market-item:visible").count(), 1);
    await page.locator("#m12-market-query").fill("");
    await page.locator("#m12-market-query").dispatchEvent("change");
    await page.locator("#offer-pass-angebot-0").click();
    await page.evaluate(() => document.querySelector("#m12-refresh").click());
    assert.equal(await page.evaluate(() => document.activeElement?.id), "offer-pass-angebot-0");
    assert.equal(await page.locator('details[data-preserve-disclosure="offer-angebot-0"]').getAttribute("open"), "");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('details[data-preserve-disclosure="offer-angebot-0"]').getAttribute("open"), null);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "offer-pass-angebot-0");
    await page.getByText("Eigenes Fahrzeug anbieten", { exact: true }).click();
    await page.locator('#m12-listing-form input[name="priceEuros"]').fill("123.456,78");
    await page.evaluate(() => document.querySelector("#m12-refresh").click());
    assert.equal(await page.locator('#m12-listing-form input[name="priceEuros"]').inputValue(), "123.456,78");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")), "priceEuros");
    assert.equal(await page.locator('details[data-preserve-disclosure="listing-compose"]').getAttribute("open"), "");
    await page.getByRole("tab", { name: "Fahrzeuge", exact: true }).focus();
    await page.keyboard.press("End");
    assert.equal(await page.locator("#tab-vehicle-register").getAttribute("aria-selected"), "true");
    await page.locator("#vehicle-registry-query").fill("612-ALT");
    await page.locator("#vehicle-registry-search").getByRole("button", { name: "Suchen", exact: true }).click();
    assert.equal(await page.locator(".vehicle-register-entry:visible").count(), 1);
    assert.match(await page.locator(".vehicle-register-entry:visible").innerText(), /Ausgemustert/i);
    await layout("vehicle-register", width);
    await page.locator(".vehicle-register-entry:visible").click();
    await page.locator("#vehicle-HZ-612-ALT").waitFor({ state: "visible" });
    assert.match(await page.locator(".vehicle-passport").innerText(), /Ausgemustert/i);
    assert.match(await page.locator(".vehicle-passport").innerText(), /Eigentümer: Nordlicht Bahn/);
    await layout("retired-passport", width);
    await page.goto(`${origin}/?screen=markets#vehicle-NL-001`);
    await page.locator("#vehicle-NL-001").waitFor({ state: "visible" });
    assert.equal(await page.locator("#tab-vehicle-register").getAttribute("aria-selected"), "true");
    assert.match(await page.locator(".vehicle-passport").innerText(), /Datenstand: Tag/);
    assert.match(await page.locator(".vehicle-passport").innerText(), /Halter: Nordlicht Bahn/);
    assert.match(await page.locator(".vehicle-passport").innerText(), /Verkauft/);
    await page.locator(".vehicle-passport").evaluate(element => element.scrollIntoView({ block: "start" }));
    await layout("direct-passport", width);
    if (width === 1440 || width === 390) await page.screenshot({ path: `${output}/${width === 1440 ? "m12-passport" : "m12-passport-mobile"}.png` });
    checks.push({ width, filtering: true, keyboardTabs: true, retainedDraftAndFocus: true, registrySearch: true, retiredVehicle: true, directPassport: true, readableHistory: true });
  }
  await page.goto(`${origin}/?screen=company#company-fleet`);
  await page.getByText("Betrieb aufgeben", { exact: true }).click();
  await page.locator('#company-exit-form input[name="price:NL-001"]').fill("987.654,32");
  await page.getByRole("tab", { name: "Finanzen", exact: true }).click();
  await page.getByRole("tab", { name: "Deine Flotte", exact: true }).click();
  assert.equal(await page.locator('#company-exit-form input[name="price:NL-001"]').inputValue(), "987.654,32");
  assert.equal(await page.locator('#company-exit-form input[name="confirmExit"]').isChecked(), false);
  await layout("company-exit-form", 320);
  assert.deepEqual(errors, [], "Browser exceptions");
} finally {
  await writeFile(`${output}/m12-qa.json`, JSON.stringify({ layouts, checks, errors }, null, 2));
  await browser.close();
}
console.log(`${layouts.length} vehicle-market/register/passport layouts and ${checks.length} responsive behavior checks passed.`);
