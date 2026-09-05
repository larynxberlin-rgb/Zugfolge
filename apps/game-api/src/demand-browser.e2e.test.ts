import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demandOverviewMarkup, trainDemandMarkup, type DemandOverview } from "../../livemap/src/demand.js";

const repo = resolve(import.meta.dirname, "../../..");
const worldId = "11111111-1111-4111-8111-111111111111";
const operatorId = "22222222-2222-4222-8222-222222222222";
// Labelled synthetic fixtures exercise browser behaviour; no claim about live-world demand.
const period = {worldId, periodId: "Beispielperiode", periodStartS: 0, periodEndS: 86_400, asOfS: 600, releaseId: "Beispielrelease", source: "forecast" as const};
const overview: DemandOverview = {...period, schemaVersion: "zugfolge-demand-overview/v1", items: Array.from({length: 50}, (_, index) => ({stationId: `station-${index}`, label: index === 0 ? "Berlin Hauptbahnhof" : `Beispielbahnhof ${index}`, requestedPassengers: null, servedPassengers: index % 3 === 0 ? null : index * 21, unservedPassengers: null})), zones: Array.from({length: 50}, (_, index) => ({zoneId: `zone-${index}`, label: `Beispielgebiet ${index}`, requestedPassengers: 400, servedPassengers: 210, unservedPassengers: 40, alternativePassengers: 150})), nextCursor: "next-fixture-page"};
const catalog = {schemaVersion: "zugfolge-spfv-catalog/v1", ...period, operatorId, defaultHeadwayS: 3_600, stops: [{id: "berlin", label: "Berlin Hauptbahnhof"}, {id: "leipzig", label: "Leipzig Hauptbahnhof"}, {id: "erfurt", label: "Erfurt Hauptbahnhof"}], formations: [{id: "formation-1", label: "Beispielzugverband", seats: 240, firstClassSeats: 32, bicyclePlaces: 8, wheelchairPlaces: 2}], lines: [{id: "existing-line", referenceTrainId: "release-reference-1", name: "Bestehende Beispielleinie", stopIds: ["berlin", "leipzig", "erfurt"], headwayS: 3600, fareCents: "2990", formationId: "formation-1", validFromS: 21600, validUntilS: 79200}]};

(process.env["ZUGFOLGE_BROWSER_E2E"] === "1" ? describe : describe.skip)("M10 Nachfrage und Fernverkehr im Browser", () => {
  let app: FastifyInstance;
  let browser: Browser;
  let origin: string;
  let previewCount = 0;
  let rejectFirstConfirmation = false;
  let confirmBodies: {previewId: string; commandId: string}[] = [];
  let delayPreview: (() => void) | undefined;
  let pausePreview = false;
  const screenshots = process.env["ZUGFOLGE_DEMAND_SCREENSHOT_DIR"];
  beforeAll(async () => {
    app = Fastify();
    const dist = resolve(repo, "apps/game-web/dist");
    app.get("/", async (_request, reply) => reply.type("text/html").send(readFileSync(resolve(dist, "index.html"))));
    app.get("/assets/*", async (request, reply) => {
      const path = resolve(dist, "assets", (request.params as {"*": string})["*"]);
      if (!path.startsWith(`${resolve(dist, "assets")}${sep}`) || !existsSync(path)) return reply.code(404).send();
      return reply.type(extname(path) === ".css" ? "text/css" : "text/javascript").send(readFileSync(path));
    });
    app.get("/runtime-config.js", async (_request, reply) => reply.type("text/javascript").send(`globalThis.__ZUGFOLGE_RUNTIME_CONFIG__=${JSON.stringify({publicWorldId: worldId, gameApiUrl: "/api", keycloakUrl: "http://localhost/keycloak", livemapUrl: "/map"})};sessionStorage.setItem('zugfolge.oidc.game-web.accessToken','fixture-token');sessionStorage.setItem('zugfolge.oidc.game-web.accessTokenExpiresAt',String(Date.now()+3600000));localStorage.setItem('zugfolge.game-hints.enabled','false');`));
    app.get(`/api/worlds/${worldId}/me/operator-context`, async () => ({schemaVersion: "zugfolge-operator-context/v1", worldId, operators: [{id: operatorId, name: "Beispielbahn", finance: {mode: "unlimited"}}]}));
    const base = `/api/worlds/${worldId}/operators/${operatorId}/spfv`;
    app.get(`${base}/catalog`, async () => catalog);
    app.post(`${base}/preview`, async (request) => {
      previewCount++;
      if (pausePreview) await new Promise<void>((resolve) => { delayPreview = resolve; });
      const replacementTrips = (request.body as {lineId?: string}).lineId ? [101, 103].map((number, index) => ({
        trainId: `player-existing-${number}`, trainNumber: number, departureS: 21600 + index * 3600,
        originLabel: "Berlin Hauptbahnhof", destinationLabel: "Erfurt Hauptbahnhof"})) : [];
      return {schemaVersion: "zugfolge-spfv-preview/v1", ...period, operatorId, previewId: `preview-${previewCount}`, requestedPassengers: 510, servedPassengers: 420, unservedPassengers: 90, capacity: 240, capacityFacts: {standardSeats: 200, premiumSeats: 40, bicycleSpaces: 6, wheelchairSpaces: 2}, replacementTrainIds: replacementTrips.map((trip) => trip.trainId), replacementTrips, fareRevenueCents: "1255800", costsCents: null, connectionEffects: ["Leipzig: Anschluss nach Halle mit 8 Minuten Übergang; 14 Modellreisende betroffen."], conflicts: [], confirmationAllowed: true, submittedDraft: request.body};
    });
    app.post(`${base}/confirm`, async (request, reply) => {
      confirmBodies.push(request.body as {previewId: string; commandId: string});
      if (rejectFirstConfirmation) { rejectFirstConfirmation = false; return reply.code(503).send({error: "Beispiel: Bestätigungsantwort verloren. Wiederhole die gleiche Einreichung."}); }
      return {lineId: "Beispiel-Fernlinie", status: "submitted", planningRequestIds: ["planning-request-1"]};
    });
    app.get("/demand-preview", async (_request, reply) => reply.type("text/html").send(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${readFileSync(resolve(repo, "packages/design-system/src/railway.css"), "utf8")}${readFileSync(resolve(repo, "apps/livemap/src/demand.css"), "utf8")}body{margin:0;background:#101419;font-family:Arial,sans-serif;color:#f5f7fa}main{box-sizing:border-box;width:min(100%,520px);padding:20px;margin:auto}button{font:inherit}button:focus-visible{outline:2px solid #fff}</style><body><main><p>Browserprüfung · ausdrücklich synthetische Beispieldaten</p>${demandOverviewMarkup(overview)}${trainDemandMarkup({...period, schemaVersion: "zugfolge-train-demand/v1", trainId: "fixture-train", segments: [{fromStationId: "berlin",fromStationLabel: "Berlin",toStationId: "leipzig",toStationLabel: "Leipzig",onboard: null,capacity: 240}],stops: [{stationId: "leipzig", label: "Leipzig Hauptbahnhof", arrivalS: 39_600,departureS: 39_720}]})}</main></body></html>`));
    origin = await app.listen({host: "127.0.0.1", port: 0});
    const executablePath = [process.env["ZUGFOLGE_BROWSER_EXECUTABLE"], "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path !== undefined && existsSync(path));
    if (!executablePath) throw new Error("M10-Browserprüfung benötigt Chrome oder Chromium.");
    browser = await chromium.launch({executablePath, headless: true, args: ["--no-sandbox"]});
    if (screenshots) mkdirSync(screenshots, {recursive: true});
  });
  afterAll(async () => { delayPreview?.(); await browser?.close(); await app?.close(); });
  const open = async (page: Page): Promise<void> => {
    await page.goto(`${origin}/?view=spfv&world=foreign&operator=${operatorId}&train=FV-101&focus=train%3AFV-101&trainScope=own&trainQuery=Fern&demand=1`);
    await page.locator("#spfv-form").waitFor();
  };
  const fill = async (page: Page): Promise<void> => {
    await page.getByLabel("Linienname", {exact: true}).fill("Beispiel-Fernlinie");
    for (const id of ["berlin", "leipzig", "erfurt"]) { await page.locator("#spfv-stop-option").selectOption(id); await page.locator("#spfv-add-stop").click(); }
    await page.locator('[name="fareEuro"]').fill("29,90");
    await page.locator('[name="formationId"]').selectOption("formation-1");
    await page.locator('[name="firstTime"]').fill("06:00");
    await page.locator('[name="lastTime"]').fill("22:00");
    await page.locator('[name="lastDay"]').fill("1");
  };
  it("prüft eine Linie, verwirft veraltete Vorschauen und wiederholt eine verlorene Bestätigung idempotent", {timeout: 20_000}, async () => {
    const page = await browser.newPage({viewport: {width: 1366, height: 900}});
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    confirmBodies = []; rejectFirstConfirmation = true;
    try {
      await open(page); await fill(page);
      expect(await page.locator('[name="name"]').inputValue()).toBe("Beispiel-Fernlinie");
      await page.getByRole("button", {name: "Nachfrage & Trassen prüfen"}).click();
      await page.locator("#spfv-confirm").waitFor();
      expect(await page.locator(".spfv-preview").innerText()).toContain("Betriebskosten im Zeitraum\nnicht verfügbar");
      await page.locator('[name="fareEuro"]').fill("30,00");
      expect(await page.locator("#spfv-confirm").count()).toBe(0);
      await page.getByRole("button", {name: "Nachfrage & Trassen prüfen"}).click(); await page.locator("#spfv-confirm").waitFor();
      if (screenshots) await page.screenshot({path: resolve(screenshots, "spfv-desktop.png"), fullPage: true});
      await page.locator("#spfv-confirm").click();
      await expect.poll(() => page.locator('[role="alert"]').innerText()).toContain("Bestätigungsantwort verloren");
      await page.locator("#spfv-confirm").click();
      await expect.poll(() => page.locator("#root").innerText()).toContain("Linie zur Planung eingereicht");
      expect(confirmBodies).toHaveLength(2); expect(confirmBodies[0]).toEqual(confirmBodies[1]);
      const returnUrl = new URL(await page.getByRole("link", {name: "Zur ausgewählten Karte"}).getAttribute("href") ?? "", origin);
      expect(returnUrl.searchParams.get("focus")).toBe("train:FV-101"); expect(returnUrl.searchParams.get("trainScope")).toBe("own"); expect(returnUrl.searchParams.get("world")).toBe(worldId);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });
  it("wendet eine verspätete Antwort nicht auf einen zwischenzeitlich geänderten Entwurf an", {timeout: 20_000}, async () => {
    const page = await browser.newPage();
    try {
      await open(page); await fill(page); pausePreview = true;
      await page.getByRole("button", {name: "Nachfrage & Trassen prüfen"}).click();
      await expect.poll(() => delayPreview !== undefined).toBe(true);
      await page.locator('[name="fareEuro"]').fill("35,00");
      pausePreview = false; delayPreview?.(); delayPreview = undefined;
      await expect.poll(() => page.locator("#root").innerText()).toContain("während der Prüfung geändert");
      expect(await page.locator("#spfv-confirm").count()).toBe(0);
      expect(await page.locator('[name="fareEuro"]').inputValue()).toBe("35,00");
    } finally { pausePreview = false; delayPreview?.(); delayPreview = undefined; await page.close(); }
  });
  it("nennt bei einer Linienänderung die tatsächlich ersetzten Fahrten vor der Bestätigung", {timeout: 20_000}, async () => {
    const page = await browser.newPage({viewport: {width: 390, height: 900}});
    try {
      await page.goto(`${origin}/?view=spfv&operator=${operatorId}&train=player-existing-101&trainScope=own&demand=1`);
      await page.locator("#spfv-form").waitFor();
      expect(await page.locator(".spfv-reference").innerText()).toContain("player-existing-101");
      await page.locator("#spfv-line").selectOption("existing-line");
      const previewRequest = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/preview"));
      await page.getByRole("button", {name: "Nachfrage & Trassen prüfen"}).click(); await page.locator("#spfv-confirm").waitFor();
      expect((await previewRequest).postDataJSON()).toMatchObject({lineId: "existing-line", referenceTrainId: "release-reference-1"});
      expect(await page.locator(".spfv-preview").innerText()).toContain("Bestehende Beispielleinie");
      const affected = page.getByRole("list", {name: "Zu ersetzende Fahrten"});
      expect(await affected.innerText()).toContain("Zug 101 · Tag 1, 06:00"); expect(await affected.innerText()).toContain("Zug 103 · Tag 1, 07:00");
      expect(await affected.innerText()).toContain("Berlin Hauptbahnhof → Erfurt Hauptbahnhof");
      expect(await affected.innerText()).not.toContain("player-existing-");
      await affected.focus(); expect(await affected.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await page.locator(".spfv-preview").innerText()).toContain("1. Klasse: 40 · 2. Klasse: 200 · Fahrradplätze: 6");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      const returnUrl = new URL(await page.getByRole("link", {name: "Zur ausgewählten Karte"}).getAttribute("href") ?? "", origin);
      expect(returnUrl.searchParams.get("focus")).toBe("train:player-existing-101");
      await page.locator("#spfv-line").selectOption(""); await fill(page);
      const newLineRequest = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/preview"));
      await page.getByRole("button", {name: "Nachfrage & Trassen prüfen"}).click(); await page.locator("#spfv-confirm").waitFor();
      expect((await newLineRequest).postDataJSON()).not.toHaveProperty("referenceTrainId");
    } finally { await page.close(); }
  });
  it("hält Navigation und Formulare auf Desktop, Notebook, Tablet und schmalen Displays innerhalb des Viewports", {timeout: 20_000}, async () => {
    const page = await browser.newPage();
    try {
      for (const width of [1920, 1366, 768, 390, 320]) {
        await page.setViewportSize({width, height: 900}); await open(page); await fill(page);
        await page.getByRole("button", {name: "Nachfrage & Trassen prüfen"}).click(); await page.locator("#spfv-confirm").waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.locator("#spfv-confirm").scrollIntoViewIfNeeded();
        const box = await page.locator("#spfv-confirm").boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
        if (screenshots && width === 390) await page.screenshot({path: resolve(screenshots, "spfv-mobile.png")});
      }
    } finally { await page.close(); }
  });
  it("rendert 50 Gebiete plus dichte Knoten begrenzt, mit zugänglicher Tabelle und fehlenden Werten", {timeout: 20_000}, async () => {
    const page = await browser.newPage();
    try {
      for (const width of [1366, 390, 320]) {
        await page.setViewportSize({width, height: 900}); await page.goto(`${origin}/demand-preview`);
        expect(await page.locator("tbody tr").count()).toBe(100);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.getByRole("region", {name: "Gebietsnachfrage als Tabelle"}).focus();
        expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("region");
        const disclosure = page.locator("details").filter({has: page.getByText("Auslastung je Streckenabschnitt", {exact: true})});
        if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open))) await page.getByText("Auslastung je Streckenabschnitt", {exact: true}).click();
        await expect.poll(() => page.getByText("Auslastung nicht verfügbar", {exact: true}).isVisible()).toBe(true);
        expect(await page.locator("meter").count()).toBe(0);
        if (screenshots && width === 390) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({path: resolve(screenshots, "demand-mobile.png")}); }
      }
    } finally { await page.close(); }
  });
});
