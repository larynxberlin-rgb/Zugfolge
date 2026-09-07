import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../..");
const worldId = "11111111-1111-4111-8111-111111111111";
const contract = {
  schemaVersion: "zugfolge-public-world-contract/v1", contractHash: "a".repeat(64), worldId, name: "Testnetz",
  region: { id: "testnetz", name: "Testnetz", variant: "A" }, noWipe: true, schedulePeriodWeeks: 4,
  duration: { kind: "periods", periodCount: 10 }, timeBasis: { mode: "realtime", accelerationFactor: 1, epoch: "2026-01-01T00:00:00Z", timeZone: "Europe/Berlin" },
  entry: { status: "open", requiresContractConfirmation: true, opensAt: "2026-01-01T00:00:00Z", closesAt: "2027-01-01T00:00:00Z" },
  startingCapitalPolicy: { kind: "finite", amountCents: "500000" },
  releases: { infra: "b".repeat(64), timetable: "c".repeat(64), fleet: "d".repeat(64), economy: "e".repeat(64) },
};

(process.env["ZUGFOLGE_BROWSER_E2E"] === "1" ? describe : describe.skip)("Neue Spielhinweise im Browser", () => {
  let app: FastifyInstance;
  let browser: Browser;
  let origin: string;
  const requests: { method: string; url: string }[] = [];
  const companyOperatorId = "33333333-3333-4333-8333-333333333333";
  let companyEnabled = false;
  const exitBodies: unknown[] = [];

  beforeAll(async () => {
    app = Fastify();
    app.addHook("onRequest", async (request) => { requests.push({ method: request.method, url: request.url }); });
    app.get("/hint-module.js", async (_request, reply) => reply.type("text/javascript").send(readFileSync(resolve(repo, "packages/design-system/dist/game-hints.js"))));
    app.get("/hint-style.css", async (_request, reply) => reply.type("text/css").send(readFileSync(resolve(repo, "packages/design-system/src/styles.css"))));
    app.get("/hint-check", async (_request, reply) => reply.type("text/html").send(`<!doctype html><html lang="de"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/hint-style.css"><body><main id="root" style="padding:24px"><form><label>Name <input id="name"></label><button id="commit">Speichern</button></form></main><script type="module">
      import { mountGameHints } from '/hint-module.js';
      document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); document.body.dataset.committed='yes'; });
      mountGameHints(document.querySelector('#root'), [
        {id:'name', selector:'#name', title:'Namen wählen', text:'Dieser Name wird in der Ansicht angezeigt.'},
        {id:'commit', selector:'#commit', title:'Eingabe speichern', text:'Erst Ihre Bestätigung speichert die Eingabe.'}
      ]);
    </script></body></html>`));
    const dist = resolve(repo, "apps/game-web/dist");
    app.get("/", async (_request, reply) => reply.type("text/html").send(readFileSync(resolve(dist, "index.html"))));
    app.get("/assets/*", async (request, reply) => {
      const path = resolve(dist, "assets", (request.params as { "*": string })["*"]);
      if (!path.startsWith(`${resolve(dist, "assets")}${sep}`) || !existsSync(path)) return reply.code(404).send();
      return reply.type(extname(path) === ".css" ? "text/css" : "text/javascript").send(readFileSync(path));
    });
    app.get("/runtime-config.js", async (_request, reply) => reply.type("text/javascript").send(`globalThis.__ZUGFOLGE_RUNTIME_CONFIG__=${JSON.stringify({ publicWorldId: worldId, gameApiUrl: "/api", keycloakUrl: "http://localhost/keycloak" })};sessionStorage.setItem('zugfolge.oidc.game-web.accessToken','test');sessionStorage.setItem('zugfolge.oidc.game-web.accessTokenExpiresAt',String(Date.now()+3600000));`));
    app.get("/api/public-world-contracts", async () => [contract, { ...contract, worldId: "22222222-2222-4222-8222-222222222222", name: "Fremdes Netz" }]);
    app.get(`/api/worlds/${worldId}/me/operator-context`, async () => ({ schemaVersion: "zugfolge-operator-context/v1", worldId, operators: companyEnabled ? [{ id: companyOperatorId, name: "Testbahn", finance: { mode: "finite", ledgerBalanceCents: "500000", pendingDebitCents: "0", availableCents: "500000" } }] : [] }));
    app.get(`/api/worlds/${worldId}/simulation-time`, async () => ({ atS: 0 }));
    app.get(`/api/worlds/${worldId}/operators`, async () => companyEnabled ? [{ id: companyOperatorId, worldId, name: "Testbahn" }] : []);
    app.get(`/api/worlds/${worldId}/mailbox`, async () => []);
    app.get(`/api/worlds/${worldId}/vehicle-market/listings`, async () => ({ schemaVersion: "zugfolge-cooperation-page/v1", items: [], nextCursor: null }));
    app.get(`/api/worlds/${worldId}/vehicle-register`, async () => ({ schemaVersion: "zugfolge-vehicle-register-page/v1", worldId, items: [], nextCursor: null }));
    app.get(`/api/worlds/${worldId}/operators/${companyOperatorId}/contracts`, async () => ({ schemaVersion: "zugfolge-cooperation-page/v1", items: [], nextCursor: null }));
    app.get(`/api/worlds/${worldId}/operators/${companyOperatorId}/vehicles`, async () => [{ worldId, vehicleId: "vehicle-442", classDesignation: "Baureihe 442", ownerOperatorId: companyOperatorId, holderOperatorId: companyOperatorId, odometerMetres: null, conditionBasisPoints: null, conditionProfile: {}, damages: [], maintenanceDeadlines: [], bindings: {}, valueCents: "150000000", revision: 1, historyHash: "f".repeat(64) }]);
    app.get(`/api/worlds/${worldId}/operators/${companyOperatorId}/cooperation-resources`, async () => ({ schemaVersion: "zugfolge-cooperation-resource-catalog/v1", worldId, operatorId: companyOperatorId, fleetRevision: 1, fleetSnapshotHash: "f".repeat(64), trainRuns: [], connectionTrainRuns: [], formations: [], publicEntryFacilities: [], personnelDuties: [], pathReceipts: [], disruptions: [], rentableVehicles: [], assistanceVehicles: [] }));
    app.post(`/api/worlds/${worldId}/operators/${companyOperatorId}/fleet-exit`, async request => { exitBodies.push(request.body); companyEnabled = false; return { ended: true }; });
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const executablePath = [process.env["ZUGFOLGE_BROWSER_EXECUTABLE"], "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path !== undefined && existsSync(path));
    if (executablePath === undefined) throw new Error("Browserprüfung braucht Chrome oder Chromium.");
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  });
  afterAll(async () => { await browser?.close(); await app?.close(); });

  async function visible(page: Page): Promise<boolean> { return page.getByRole("tooltip").isVisible(); }

  it("öffnet per Tastatur, schließt ohne Fokusfalle und erhält echte Formulare", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/hint-check`);
      await expect.poll(() => visible(page)).toBe(true);
      const count = requests.length;
      await page.keyboard.press("Escape");
      expect(await visible(page)).toBe(false);
      await page.locator('[data-game-hint="commit"]').focus();
      expect(await page.getByRole("tooltip").innerText()).toContain("Eingabe speichern");
      await page.keyboard.press("Tab");
      expect(await visible(page)).toBe(false);
      expect(await page.locator("body").getAttribute("data-committed")).toBeNull();
      expect(requests.slice(count)).toEqual([]);
      await page.locator("#commit").click();
      expect(await page.locator("body").getAttribute("data-committed")).toBe("yes");
    } finally { await context.close(); }
  });

  it("merkt Abschalten, übersteht Neurendern und bleibt auf Touch im sichtbaren Fenster", async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/hint-check`);
      await page.getByRole("button", { name: "Spielhinweise", exact: true }).tap();
      await page.reload();
      expect(await page.locator(".zf-game-hint-trigger:visible").count()).toBe(0);
      await page.getByRole("button", { name: "Spielhinweise", exact: true }).tap();
      await page.evaluate(() => { const root = document.querySelector("#root")!; root.innerHTML = '<button id="commit">Speichern</button>'; });
      await expect.poll(() => page.locator(".zf-game-hint-trigger").count()).toBe(1);
      await page.locator('[data-game-hint="commit"]').tap();
      const box = await page.getByRole("tooltip").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      expect(box!.y + box!.height).toBeLessThanOrEqual(568);
      await page.keyboard.press("Escape");
      await page.reload();
      expect(await page.locator(".zf-game-hint-trigger").count()).toBe(2);
    } finally { await context.close(); }
  });

  it("zeigt neue Hinweise im echten Spielbuild und ignoriert fremde Weltparameter", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const start = requests.length;
      await page.goto(`${origin}/?view=journey&section=world&world=foreign&publicWorld=foreign`);
      await page.locator('.world-contracts .world-contract-entry').waitFor();
      await page.locator('[data-game-hint="entry-contract"]').focus();
      expect(await page.getByRole("tooltip").innerText()).toContain("Willkommen an Bord.");
      expect(await page.locator(".world-contracts").count()).toBe(1);
      expect(await page.locator(".world-contracts").innerText()).toContain("Testnetz");
      expect(await page.locator("#operator-foundation-form").count()).toBe(0);
      expect(requests.slice(start).filter(({ method }) => method !== "GET")).toEqual([]);
      expect(requests.slice(start).some(({ url }) => url.includes("/worlds/foreign/"))).toBe(false);
      expect(errors).toEqual([]);
      if (process.env["ZUGFOLGE_HINT_SCREENSHOT"] !== undefined) await page.screenshot({ path: process.env["ZUGFOLGE_HINT_SCREENSHOT"], fullPage: true });
    } finally { await context.close(); }
  });

  it("sendet eine Betriebsaufgabe erst nach der ausdrücklichen Bestätigung und erhält zuvor den Preis", async () => {
    companyEnabled = true;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/?view=journey&section=company#company-fleet`);
      await page.getByText("Betrieb aufgeben", { exact: true }).click();
      await page.locator('#company-exit-form input[name="price:vehicle-442"]').fill("1.234.567,89");
      await page.locator('#company-exit-form input[name="confirmExit"]').check();
      await page.locator('#company-exit-form button[type="submit"]').click();
      await page.locator("#journey-confirmation").waitFor({ state: "visible" });
      expect(exitBodies).toHaveLength(0);
      expect(await page.locator("#confirmation-detail").innerText()).toContain("1.234.567,89 €");
      expect(await page.locator("#confirmation-detail").innerText()).toContain("dauerhaft beendet");
      await page.locator("#confirmation-cancel").click();
      expect(exitBodies).toHaveLength(0);
      expect(await page.locator('#company-exit-form input[name="price:vehicle-442"]').inputValue()).toBe("1.234.567,89");
      await page.locator('#company-exit-form button[type="submit"]').click();
      await page.locator("#confirmation-submit").click();
      await expect.poll(() => exitBodies.length).toBe(1);
      expect(exitBodies[0]).toMatchObject({ salePrices: { "vehicle-442": "123456789" }, idempotencyKey: expect.any(String) });
    } finally { companyEnabled = false; await context.close(); }
  });
});
