import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemandMapFixture } from "./demand-map-fixture.js";

// Synthetic workload, not a released Germany corpus or an operating-world proof.
// The shipped LiveMap bundle, MapLibre workers, PMTiles ranges and UI execute unchanged.
const repo = resolve(import.meta.dirname, "../../..");
const WORLD = "11111111-1111-4111-8111-111111111111", OPERATOR = "22222222-2222-4222-8222-222222222222";
const RELEASE = "synthetic-germany-m10-browser";
const period = {worldId: WORLD, periodId: "Synthetisches Lastfenster", periodStartS: 0, periodEndS: 86400, asOfS: 3600, source: "assumption", releaseId: RELEASE};
const browserDescribe = process.env["ZUGFOLGE_BROWSER_E2E"] === "1" ? describe : describe.skip;

browserDescribe("M10 echte MapLibre-Oberfläche unter synthetischer Deutschland- und Knotenlast", () => {
  let app: FastifyInstance, browser: Browser, origin: string;
  let fixture: ReturnType<typeof createDemandMapFixture>;
  let trains: Record<string, unknown>[];
  let stations: ReturnType<typeof createDemandMapFixture>["stations"];
  const streams = new Set<ServerResponse>();
  const report: Record<string, unknown>[] = [];
  const requests: string[] = [];
  let rangeRequests = 0, sequence = 1;
  const screenshotDir = process.env["ZUGFOLGE_DEMAND_MAP_SCREENSHOT_DIR"];
  beforeAll(async () => {
    fixture = createDemandMapFixture();
    // First page spans Germany, second page is concentrated in the node; all 5,400 rows remain pageable.
    const first = fixture.stations.filter((_station, index) => index < 5000 && index % 100 === 0);
    const second = fixture.stations.slice(5000, 5050);
    const selected = new Set([...first, ...second].map((station) => station.id));
    stations = [...first, ...second, ...fixture.stations.filter((station) => !selected.has(station.id))];
    trains = Array.from({length: 5000}, (_value, index) => {
      const station = index < 400 ? fixture.stations[5000 + index]! : fixture.stations[index - 400]!;
      return {id: `synthetic-train-${index}`, operatorId: index % 2 === 0 ? OPERATOR : "other-fixture-operator", operator: "Synthetische Testbahn",
        trainNumber: `FV ${10000 + index}`, category: "FV", positionMm: 1000, speedMmPerSecond: 0,
        delaySeconds: index % 10 === 0 ? 120 : 0, nextOperatingPoint: station.label, status: index % 17 === 0 ? "waiting" : "running",
        mapPosition: {infrastructureReleaseId: RELEASE, resourceId: `fixture-resource-${index}`, trackId: `fixture-track-${index}`,
          offsetMm: 1000, latitudeE7: station.latitudeE7, longitudeE7: station.longitudeE7}};
    });
    app = Fastify();
    const mapDist = resolve(repo, "apps/livemap/dist"), plannerDist = resolve(repo, "apps/game-web/dist");
    app.get("/map", async (_request, reply) => reply.type("text/html").send(readFileSync(resolve(mapDist, "index.html"))));
    app.get("/planner", async (_request, reply) => reply.type("text/html").send(readFileSync(resolve(plannerDist, "index.html"))));
    app.get("/assets/*", async (request, reply) => {
      for (const dist of [mapDist, plannerDist]) {
        const path = resolve(dist, "assets", (request.params as {"*": string})["*"]);
        if (path.startsWith(`${resolve(dist, "assets")}${sep}`) && existsSync(path))
          return reply.type(extname(path) === ".css" ? "text/css" : "text/javascript").send(readFileSync(path));
      }
      return reply.code(404).send();
    });
    app.get("/maplibre/*", async (request, reply) => {
      const path = resolve(mapDist, "maplibre", (request.params as {"*": string})["*"]);
      if (!path.startsWith(`${resolve(mapDist, "maplibre")}${sep}`) || !existsSync(path)) return reply.code(404).send();
      return reply.type("text/javascript").send(readFileSync(path));
    });
    app.get("/runtime-config.js", async (_request, reply) => reply.type("text/javascript").send(`globalThis.__ZUGFOLGE_RUNTIME_CONFIG__=${JSON.stringify({publicWorldId: WORLD, gameApiUrl: "/api", keycloakUrl: "http://localhost/keycloak", gameWebUrl: "/planner", livemapUrl: "/map", operationsCenterUrl: "/operations"})};for(const client of ['livemap','game-web']){sessionStorage.setItem('zugfolge.oidc.'+client+'.accessToken','explicit-browser-fixture');sessionStorage.setItem('zugfolge.oidc.'+client+'.accessTokenExpiresAt',String(Date.now()+3600000));}localStorage.setItem('zugfolge.game-hints.enabled','false');`));
    app.get("/style.json", async () => ({version: 8, glyphs: "/glyphs/{fontstack}/{range}.pbf", sources: {}, layers: [{id: "background", type: "background", paint: {"background-color": "#111920"}}]}));
    app.get("/glyphs/:font/:range", async (_request, reply) => reply.type("application/x-protobuf").send(readFileSync(resolve(import.meta.dirname, "fixtures/demand-map-font/0-255.pbf"))));
    app.get("/synthetic.pmtiles", async (request, reply) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (match === null) return reply.header("accept-ranges", "bytes").send(fixture.archive);
      rangeRequests++;
      const start = Number(match[1]), end = Math.min(Number(match[2]), fixture.archive.length - 1);
      return reply.code(206).header("accept-ranges", "bytes").header("content-range", `bytes ${start}-${end}/${fixture.archive.length}`)
        .header("etag", '"synthetic-v1"').send(fixture.archive.subarray(start, end + 1));
    });
    const base = `/api/worlds/${WORLD}`;
    app.get(`${base}/livemap/config`, async () => ({schemaVersion: "zugfolge-livemap-config/v2", worldId: WORLD,
      worldName: "Synthetischer Deutschland-/Knotenlasttest", infrastructureReleaseId: RELEASE,
      basemap: {styleUrl: "/style.json", attribution: "Synthetische Testgeometrie", selfHosted: true},
      infrastructure: {pmtilesUrl: "/synthetic.pmtiles", attribution: "Synthetische Testgeometrie", coverage: "DE"},
      initialView: {latitudeE7: 510000000, longitudeE7: 105000000, zoomMilli: 5000}}));
    app.get(`${base}/me/operator-context`, async () => ({schemaVersion: "zugfolge-operator-context/v1", worldId: WORLD,
      operators: [{id: OPERATOR, name: "Synthetische Testbahn", finance: {mode: "unlimited"}}]}));
    app.get(`${base}/mailbox`, async () => []);
    app.get(`${base}/livemap/snapshot`, async () => ({worldId: WORLD, streamId: "synthetic-stream", sequence, at: sequence,
      trains}));
    app.get(`${base}/livemap/events`, (request, reply) => {
      reply.hijack(); reply.raw.writeHead(200, {"content-type": "text/event-stream", "cache-control": "no-store"}); reply.raw.write(": synthetic stream\n\n");
      streams.add(reply.raw); request.raw.on("close", () => streams.delete(reply.raw));
    });
    app.get(`${base}/demand/overview`, async (request) => {
      requests.push(request.url);
      const query = request.query as {cursor?: string; limit?: string};
      const start = Number(query.cursor ?? 0), page = stations.slice(start, start + 50);
      return {schemaVersion: "zugfolge-demand-overview/v1", ...period,
        items: page.map((station, index) => ({stationId: station.id, label: station.label, latitudeE7: station.latitudeE7,
          longitudeE7: station.longitudeE7, requestedPassengers: null, unservedPassengers: null, servedPassengers: index % 3 === 0 ? null : index * 7})),
        zones: page.map((station) => ({zoneId: `zone-${station.id}`, label: `Gebiet ${station.label}`, requestedPassengers: 100,
          servedPassengers: 60, unservedPassengers: 20, alternativePassengers: 20})), nextCursor: start + 50 < stations.length ? String(start + 50) : null};
    });
    app.get(`${base}/livemap/trains/:train`, async (request) => {
      const train = trains.find((candidate) => candidate["id"] === (request.params as {train: string}).train)!;
      return {schemaVersion: "zugfolge-livemap-train-detail/v1", worldId: WORLD, infrastructureReleaseId: RELEASE,
        movement: "network", train, fis: {category: "FV", trainNumber: String(train["trainNumber"]), destination: "Synthetisches Ziel",
          nextStop: "Synthetischer Knoten", followingStops: [], messages: ["Ausdrücklich synthetischer Browsertest"]}};
    });
    app.get(`${base}/demand/trains/:train`, async (request) => ({schemaVersion: "zugfolge-train-demand/v1", ...period,
      trainId: (request.params as {train: string}).train, segments: [{fromStationId: "fixture-a", fromStationLabel: "Synthetischer Start", toStationId: "fixture-b", toStationLabel: "Synthetisches Ziel", onboard: null, capacity: 200}],
      stops: [{stationId: "fixture-a", label: "Synthetischer Start", arrivalS: 3600, departureS: 3660}]}));
    app.get(`${base}/operators/${OPERATOR}/spfv/catalog`, async () => ({schemaVersion: "zugfolge-spfv-catalog/v1", ...period, operatorId: OPERATOR,
      defaultHeadwayS: 3600, stops: stations.slice(0, 3).map((station) => ({id: station.id, label: station.label})), formations: [], lines: []}));
    origin = await app.listen({host: "127.0.0.1", port: 0});
    const executablePath = [process.env["ZUGFOLGE_BROWSER_EXECUTABLE"], "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path !== undefined && existsSync(path));
    if (executablePath === undefined) throw new Error("MapLibre-Browsernachweis benötigt Chrome/Chromium.");
    browser = await chromium.launch({executablePath, headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader"]});
    if (screenshotDir) mkdirSync(screenshotDir, {recursive: true});
  }, 60000);
  afterAll(async () => {
    await browser?.close(); for (const stream of streams) stream.destroy(); await app?.close();
    const result = {workload: fixture?.counts, trains: 5000, denseNodeTrains: 400, rangeRequests, measurements: report};
    console.log(`M10_MAPLIBRE_WORKLOAD ${JSON.stringify(result)}`);
    if (process.env["ZUGFOLGE_DEMAND_MAP_REPORT"]) writeFileSync(process.env["ZUGFOLGE_DEMAND_MAP_REPORT"], JSON.stringify(result, null, 2));
  });

  async function visible(page: Page, selector: string): Promise<void> {
    const element = page.locator(selector); await element.scrollIntoViewIfNeeded();
    const box = await element.boundingBox(); expect(box).not.toBeNull();
    const size = page.viewportSize()!; expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y).toBeLessThan(size.height);
  }

  async function searchTrains(page: Page, query: string): Promise<void> {
    if (!await page.locator("#train-search").isVisible()) await page.locator("#toggle-insights").click();
    await page.locator("#train-search").fill(query);
    if (page.viewportSize()!.width < 1024 && await page.locator("#toggle-insights").getAttribute("aria-expanded") === "true")
      await page.locator("#toggle-insights").click();
  }

  async function visibleLegend(page: Page): Promise<void> {
    await visible(page, "#demand-map-key");
    expect(await page.locator("#demand-map-key").evaluate((legend) => {
      const a = legend.getBoundingClientRect(), b = document.querySelector(".map-tools")!.getBoundingClientRect();
      return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    })).toBe(0);
  }

  async function mapHealthy(page: Page): Promise<void> {
    expect(await page.locator(".map-state.error").count()).toBe(0);
    expect(await page.locator(".map-state").innerText()).not.toContain("konnte nicht");
  }

  for (const width of [1366, 390, 320]) it(`Deutschland, dichter Knoten und Nachfrage bleiben bei ${width}px bedienbar`, async () => {
    const page = await browser.newPage({viewport: {width, height: 900}, reducedMotion: "reduce"});
    const errors: string[] = [], external: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (request.url().startsWith("http") && !request.url().startsWith(origin)) external.push(request.url()); });
    try {
      const initialRanges = rangeRequests;
      const start = performance.now(); await page.goto(`${origin}/map?world=${WORLD}&operator=${OPERATOR}`);
      await expect.poll(() => page.locator("#train-list-count").textContent(), {timeout: 15000}).toBe("5000");
      await expect.poll(() => rangeRequests).toBeGreaterThan(initialRanges);
      const startupMs = performance.now() - start;
      expect(await page.locator("#map canvas").count()).toBe(1);
      // The list/first-range timing is not first paint. Wait for MapLibre's public hover behavior
      // to confirm that actual interactive vector features have reached the Germany overview.
      const germanyCanvas = page.locator("#map canvas"), germanyBounds = (await germanyCanvas.boundingBox())!;
      await expect.poll(async () => {
        for (const x of [0.5, 0.6, 0.4, 0.55, 0.45]) for (const y of [0.5, 0.55, 0.45]) {
          await page.mouse.move(germanyBounds.x + germanyBounds.width * x, germanyBounds.y + germanyBounds.height * y);
          if (await germanyCanvas.evaluate((canvas) => canvas.style.cursor === "pointer")) return true;
        }
        return false;
      }, {timeout: 15000}).toBe(true);
      const renderedGermanyMs = performance.now() - start;
      await mapHealthy(page);
      await visible(page, "#toggle-demand");
      const demandStart = performance.now(); await page.locator("#toggle-demand").click();
      await page.locator("[data-demand-next]").waitFor();
      const demandMs = performance.now() - demandStart;
      expect(await page.locator(".demand-table-scroll tbody tr").count()).toBe(100);
      expect(await page.locator("#details-content").innerText()).toContain("keine Zeitreihe");
      await page.locator("#close-details").click(); await visibleLegend(page);
      if (screenshotDir && width === 1366) await page.screenshot({path: resolve(screenshotDir, "demand-map-germany-1366.png")});
      await page.locator("#toggle-demand").click(); // Disable the still-active overlay after closing its panel.
      await page.locator("#toggle-demand").click(); await page.locator("[data-demand-next]").click();
      await expect.poll(() => page.locator("#details-content").innerText()).toContain("Synthetischer Knotenhalt");
      await page.locator("#close-details").click();
      await searchTrains(page, "FV 10000");
      await expect.poll(() => page.locator("#train-list-count").textContent()).toBe("1");
      if (await page.locator("#map-object-list").getAttribute("open") === null) await page.locator("#map-object-list summary").click();
      await page.locator('[data-list-train="synthetic-train-0"]').click();
      await page.locator(".demand-plan-link").waitFor();
      await page.getByText("Auslastung je Streckenabschnitt", {exact: true}).click();
      expect(await page.locator("#details-content").innerText()).toContain("nicht verfügbar");
      await page.locator("#close-details").click();
      const beforeZoom = rangeRequests;
      for (let step = 0; step < 8; step++) await page.getByRole("button", {name: "Hineinzoomen", exact: true}).click();
      await expect.poll(() => rangeRequests, {timeout: 10000}).toBeGreaterThan(beforeZoom);
      await mapHealthy(page);
      // Selection above centers the real MapLibre camera on train 0. Hit-test the rendered canvas.
      const canvas = page.locator("#map canvas"), bounds = await canvas.boundingBox();
      await canvas.click({position: {x: bounds!.width / 2, y: bounds!.height / 2}});
      await expect.poll(async () => await page.locator(".demand-plan-link").isVisible()
        || await page.locator("#selection-menu").isVisible()).toBe(true);
      if (await page.locator("#selection-menu").isVisible())
        await page.locator("#selection-menu").getByRole("button", {name: /FV 10000/}).click();
      await page.locator(".demand-plan-link").waitFor();
      expect(new URL(page.url()).searchParams.get("focus")).toBe("train:synthetic-train-0");
      await page.locator("#close-details").click();
      await searchTrains(page, "");
      await expect.poll(() => page.locator("#train-list-count").textContent()).toBe("5000");
      await visibleLegend(page);
      const frameTimes = page.evaluate(async () => {
        const frames: number[] = []; let last = performance.now(); const end = last + 2000;
        await new Promise<void>((resolve) => { const next = (now: number) => { frames.push(now - last); last = now; if (now < end) requestAnimationFrame(next); else resolve(); }; requestAnimationFrame(next); });
        return frames.sort((a, b) => a - b);
      });
      const interval = setInterval(() => {
        sequence++; const changed = trains.slice(0, 100).map((train) => ({...train, delaySeconds: sequence % 2 === 0 ? 120 : 0}));
        for (const stream of streams) stream.write(`id: synthetic-stream:${sequence}\ndata: ${JSON.stringify({worldId: WORLD, streamId: "synthetic-stream", sequence, at: sequence, changed, removed: []})}\n\n`);
      }, 200);
      let frames: number[];
      try { frames = await frameTimes; } finally { clearInterval(interval); }
      // The initial snapshot has 500 delayed trains; these counts prove actual SSE application.
      await expect.poll(() => page.locator("#network-delayed").textContent()).toMatch(/^(490|590)$/);
      await mapHealthy(page);
      const p95FrameMs = frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))]!;
      expect(startupMs).toBeLessThan(15000); expect(demandMs).toBeLessThan(2000); expect(p95FrameMs).toBeLessThan(250);
      if (screenshotDir) await page.screenshot({path: resolve(screenshotDir, `demand-map-node-${width}.png`)});
      await searchTrains(page, "FV 10000");
      if (await page.locator("#map-object-list").getAttribute("open") === null) await page.locator("#map-object-list summary").click();
      await page.locator('[data-list-train="synthetic-train-0"]').click();
      await visible(page, ".demand-plan-link");
      await page.locator(".demand-plan-link").click(); await page.locator("#spfv-form").waitFor();
      expect(new URL(page.url()).searchParams.get("train")).toBe("synthetic-train-0");
      await page.getByRole("link", {name: "Zur ausgewählten Karte"}).click();
      await page.locator(".demand-plan-link").waitFor();
      expect(await page.locator("#train-search").inputValue()).toBe("FV 10000");
      expect(new URL(page.url()).searchParams.get("demand")).toBe("1");
      await mapHealthy(page);
      expect(errors).toEqual([]); expect(external).toEqual([]);
      expect(requests.every((url) => new URL(url, origin).searchParams.get("limit") === "50")).toBe(true);
      report.push({width, startupMs: Math.round(startupMs), renderedGermanyMs: Math.round(renderedGermanyMs), demandMs: Math.round(demandMs), p95FrameMs: Math.round(p95FrameMs), frameSamples: frames.length});
    } finally { await page.close(); }
  }, 60000);
});
