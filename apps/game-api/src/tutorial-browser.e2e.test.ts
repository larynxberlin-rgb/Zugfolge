import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { AbuseGuard, TutorialSessionService } from "@zugfolge/alpha";
import {
  MIGRATIONS_FOLDER,
  odooProjectionOutbox,
  tutorialSessions,
  worlds,
} from "@zugfolge/db";
import * as schema from "@zugfolge/db/schema";
import { OperationsRegistry } from "@zugfolge/dispatch";
import { requestWorldAccess } from "@zugfolge/identity";
import { LivemapRegistry } from "@zugfolge/livemap-stream";
import { loadPlanningRuntime } from "@zugfolge/planning-runtime-native";
import { loadOperatingRuntime, loadRegionalSimulationRuntime } from "@zugfolge/runtime-native";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAlphaRoutes } from "./alpha-routes.js";
import { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import { GameTutorialWorldFactory } from "./tutorial-world-factory.js";

const PUBLIC_WORLD = "00000000-0000-4000-8000-000000000121";
const SECOND_WORLD = "00000000-0000-4000-8000-000000000122";
const TEST_NOW = new Date("2026-08-13T10:00:00.000Z");
const WEB_DIST = resolve(import.meta.dirname, "../../game-web/dist");

function browserExecutable(): string {
  const candidates = [
    process.env["ZUGFOLGE_BROWSER_EXECUTABLE"],
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((entry): entry is string => typeof entry === "string" && entry !== "");
  const found = candidates.find(existsSync);
  if (found === undefined) throw new Error("Browser-E2E braucht eine installierte Chrome- oder Chromium-Binary.");
  return found;
}

function mime(path: string): string {
  const types: Readonly<Record<string, string>> = { ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  return types[extname(path)] ?? "application/octet-stream";
}

function registerWeb(app: FastifyInstance): void {
  const index = readFileSync(resolve(WEB_DIST, "index.html"), "utf8").replace(
    '<script src="/runtime-config.js"></script>',
    `<script>globalThis.__ZUGFOLGE_RUNTIME_CONFIG__=${JSON.stringify({ gameApiUrl: "", keycloakUrl: "http://unused.invalid", keycloakRealm: "zugfolge", publicWorldId: PUBLIC_WORLD, livemapUrl: "" })};sessionStorage.setItem("zugfolge.accessToken","browser-e2e");sessionStorage.setItem("zugfolge.accessTokenExpiresAt",String(Date.now()+3600000));</script>`,
  );
  app.get("/", async (_request, reply) => reply.type("text/html").send(index));
  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
    const file = resolve(WEB_DIST, "assets", request.params["*"]);
    const assetRoot = `${resolve(WEB_DIST, "assets")}${sep}`;
    if (!file.startsWith(assetRoot) || !existsSync(file)) return reply.code(404).send({ error: "Asset fehlt." });
    return reply.type(mime(file)).send(readFileSync(file));
  });
}

async function tabUntil(page: Page, selector: string, maximumTabs = 120): Promise<void> {
  for (let index = 0; index < maximumTabs; index += 1) {
    const focused = await page.locator(selector).evaluateAll((elements) => elements.includes(document.activeElement));
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tastaturfokus erreichte ${selector} nach ${maximumTabs} Tab-Schritten nicht.`);
}

(process.env["ZUGFOLGE_BROWSER_E2E"] === "1" ? describe : describe.skip)("Tutorialreise im echten Browser", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;
  let browser: Browser | undefined;
  let origin: string;
  let serverRequests: string[];
  let serverResponses: string[];

  beforeEach(async () => {
    if (process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] === undefined || process.env["ZUGFOLGE_PLANNING_RUNTIME_NATIVE_PATH"] === undefined) {
      throw new Error("Browser-E2E braucht beide echten NAPI-Runtimes.");
    }
    if (!existsSync(resolve(WEB_DIST, "index.html"))) throw new Error("Browser-E2E braucht vorher den Game-Web-Produktionsbuild.");
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(worlds).values({ id: PUBLIC_WORLD, name: "Alpha", schedulePeriodWeeks: 4, epoch: TEST_NOW, worldKind: "public", rankingStatus: "ranked", lifecycleStatus: "active" });
    await requestWorldAccess(db, { worldId: PUBLIC_WORLD, keycloakSubject: "kc-browser-player", displayName: "Browser-Spieler" });

    const regional = new RegionalSimulationWorker(db, loadRegionalSimulationRuntime(), new LivemapRegistry(), new OperationsRegistry());
    const clock = () => TEST_NOW;
    const sessions = new TutorialSessionService(db, new GameTutorialWorldFactory(db, loadOperatingRuntime(), loadPlanningRuntime(), regional), { clock });
    app = Fastify({ logger: false });
    serverRequests = [];
    serverResponses = [];
    app.addHook("onRequest", async (request) => { serverRequests.push(`${request.method} ${request.url}`); });
    app.addHook("onResponse", async (request, reply) => { serverResponses.push(`${request.method} ${request.url} -> ${reply.statusCode}`); });
    registerAlphaRoutes(app, {
      db,
      authenticate: (async (request: FastifyRequest) => { request.identity = { keycloakSubject: "kc-browser-player" }; }) as never,
      services: { tutorialSessions: sessions, abuse: new AbuseGuard(db), pseudonymSecret: "b".repeat(32), clock },
    });
    registerWeb(app);
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
    browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: ["--no-sandbox"] });
  }, 30_000);

  afterEach(async () => {
    await browser?.close();
    await app?.close();
    await client?.close();
  });

  it("meldet an, durchlaeuft alle echten APIs, zeigt die Rechnung und archiviert vor der Rueckkehr", async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unbekannt"}`));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator("#tutorial-start:not([disabled])").waitFor();
    const startResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/worlds/${PUBLIC_WORLD}/tutorial-sessions`), { timeout: 30_000 });
    await page.getByRole("button", { name: "Tutorial mit Lutz starten" }).click();
    const startResponse = await startResponsePromise.catch(async (error: unknown) => {
      const pageText = (await page.locator("body").innerText()).slice(0, 2_000);
      throw new Error(`Tutorialstart erhielt keine Antwort. Serveranfragen: ${serverRequests.join(" | ") || "keine"}; Serverantworten: ${serverResponses.join(" | ") || "keine"}; fehlgeschlagene Browseranfragen: ${failedRequests.join(" | ") || "keine"}; Seitenfehler: ${pageErrors.join(" | ") || "keine"}; Seite: ${pageText}`, { cause: error });
    });
    if (startResponse.status() !== 201) {
      throw new Error(`Tutorialstart antwortete mit HTTP ${startResponse.status()}: ${await startResponse.text()}; Seitenfehler: ${pageErrors.join(" | ") || "keine"}`);
    }
    await page.getByRole("heading", { name: "Ein tragfähiges Angebot abgeben" }).waitFor();

    const started = await startResponse.json() as { reference?: unknown };
    const reference = typeof started.reference === "string" ? started.reference : undefined;
    expect(reference).toMatch(/^tut_[a-z2-7]{20,52}$/);
    expect((await page.locator(".tutorial-experience > header .eyebrow").innerText()).toLowerCase()).toContain(reference!);
    expect(await page.locator("#lutz-name").evaluate((element) => document.activeElement === element)).toBe(true);
    await page.getByRole("button", { name: "Ausschreibung öffnen" }).click();
    expect(await page.locator("#tutorial-chapter-1").evaluate((element) => document.activeElement === element)).toBe(true);
    const [taskBox, coachBox] = await Promise.all([page.locator(".tutorial-task").boundingBox(), page.locator(".tutorial-coach").boundingBox()]);
    expect(taskBox).not.toBeNull();
    expect(coachBox).not.toBeNull();
    expect(coachBox!.x).toBeGreaterThanOrEqual(taskBox!.x + taskBox!.width);
    expect(await page.locator(".tutorial-coach").evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");

    for (const width of [320, 390, 900]) {
      await page.setViewportSize({ width, height: 900 });
      const progressSnapshot = await page.locator(".tutorial-progress").ariaSnapshot();
      for (const text of ["Erste Ausschreibung", "Fahrzeug leasen", "Trasse beantragen", "Betriebsprogramm aktivieren", "Erste Störung", "Aktiv", "Offen"]) {
        expect(progressSnapshot).toContain(text);
      }
      expect(await page.locator('.tutorial-progress [aria-current="step"] b').innerText()).toBe("Aktiv");
      expect(await page.locator(".tutorial-progress b").evaluateAll((elements) => elements.every((element) => getComputedStyle(element).display !== "none"))).toBe(true);
      expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Ein tragfähiges Angebot abgeben" }).waitFor();
    expect((await page.locator(".tutorial-experience > header .eyebrow").innerText()).toLowerCase()).toContain(reference!);

    await page.getByLabel("Bestellerentgelt je Zug-km").fill("14,50");
    await page.getByLabel("Pünktlichkeitsversprechen").fill("92,00");
    await page.getByLabel("Zusätzliche Sitzplätze").fill("12");
    await page.getByRole("button", { name: "Angebot verbindlich abgeben" }).click();
    await page.getByRole("heading", { name: "Ein Fahrzeug selbst leasen" }).waitFor();
    await page.locator('[data-tutorial-offer="lease-economy"]').click();
    await page.getByRole("heading", { name: "Eine berechnete Trasse bestätigen" }).waitFor();
    await page.locator('[data-tutorial-path="path-robust"]').click();
    await page.getByRole("heading", { name: "Eine Regel ändern und aktivieren" }).waitFor();
    await page.getByLabel("Vorlage").selectOption("connections");
    await page.getByLabel("Entscheidungsregel").selectOption("hold-connections");
    await page.getByLabel("Regelschwelle in Minuten").fill("4,0");
    await page.getByRole("button", { name: "Geändertes Betriebsprogramm aktivieren" }).click();
    await page.getByRole("heading", { name: "Weichenstörung disponieren" }).waitFor();
    await page.locator('[data-tutorial-dispatch="request_reroute"]').click();
    await page.getByRole("heading", { name: "Ihr erster Betriebszyklus" }).waitFor();
    expect(await page.locator("#tutorial-summary").innerText()).toContain("Bestellererlös");
    expect(await page.locator("#tutorial-summary").innerText()).toContain("Störungsfolgen");

    await page.getByRole("button", { name: "Ergebnis bestätigen und Tutorialwelt schließen" }).click();
    await page.getByRole("heading", { name: "Die kurzlebige Welt ist geschlossen" }).waitFor();
    const [stored] = await db.select().from(tutorialSessions);
    expect(stored).toMatchObject({ reference, lifecycle: "archived", closureReason: "completed-confirmed" });
    expect(stored?.finalStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, stored!.tutorialWorldId))).toHaveLength(0);

    await page.getByRole("link", { name: "Öffentliche Welt öffnen" }).click();
    await page.getByRole("heading", { name: "Öffentlicher Betrieb" }).waitFor();
    const publicCard = await page.locator(".onboarding-card").innerText();
    expect(publicCard.toLowerCase()).toContain("keine startausstattung");
    expect(publicCard).toContain("signierten Weltentwurf");
  }, 60_000);

  it("bindet bei zwei Welten jede sichtbare Marktaktion an die verlinkte Welt", async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    const ownA = "10000000-0000-4000-8000-000000000001";
    const ownB = "10000000-0000-4000-8000-000000000002";
    const sellerB = "10000000-0000-4000-8000-000000000003";
    const listingId = "20000000-0000-4000-8000-000000000001";
    const mutationPaths: string[] = [];
    const mutationKeys: string[] = [];
    const contractMutationKeys: string[] = [];
    const authenticationUrls: string[] = [];
    let contractAttempts = 0;
    let reserved = false;
    let reserveAttempts = 0;
    let authenticationExpired = false;
    const worldContract = (worldId: string, name: string, hash: string) => ({
      schemaVersion: "zugfolge-public-world-contract/v1", contractHash: hash, worldId, name,
      region: { id: "mitteldeutschland-b", name: "Leipzig–Halle–Erfurt", variant: "B" }, noWipe: true, schedulePeriodWeeks: 4,
      duration: { kind: "periods", periodCount: 10 },
      timeBasis: { mode: "realtime", accelerationFactor: 1, epoch: "2026-01-01T00:00:00.000Z", timeZone: "Europe/Berlin" },
      entry: { status: "open", requiresContractConfirmation: true, opensAt: "2026-01-01T00:00:00.000Z", closesAt: "2026-11-05T00:00:00.000Z" },
      startingCapitalPolicy: { kind: "finite", amountCents: "0" },
      releases: { infra: "b".repeat(64), timetable: "c".repeat(64), fleet: "d".repeat(64), economy: "e".repeat(64) },
    });
    const listing = () => ({
      schemaVersion: "zugfolge-vehicle-market-listing/v1",
      id: listingId, worldId: SECOND_WORLD, vehicleId: "vehicle-442", offeringOperatorId: sellerB,
      listingType: "sale", priceCents: "90000000", disclosure: { classDesignation: "Baureihe 442", approvals: ["LHE"] },
      disclosureHash: "f".repeat(64), listedAtS: 1, expiresAtS: 10_000,
      status: reserved ? "reserved" : "open", ...(reserved ? { reservedByOperatorId: ownB, reservedUntilS: 700 } : {}), revision: reserved ? 2 : 1,
    });
    const comparisonListing = {
      schemaVersion: "zugfolge-vehicle-market-listing/v1",
      id: "20000000-0000-4000-8000-000000000002", worldId: SECOND_WORLD, vehicleId: "vehicle-1440", offeringOperatorId: sellerB,
      listingType: "rental", priceCents: "1200000", rentalDurationS: 2_592_000,
      disclosure: { classDesignation: "Baureihe 1440", approvals: ["LHE"], conditionBasisPoints: 8_700, mileageMm: "410000000" },
      disclosureHash: "8".repeat(64), listedAtS: 2, expiresAtS: 10_000,
      status: "reserved", reservedByOperatorId: sellerB, reservedUntilS: 800, revision: 1,
    } as const;
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === "http://unused.invalid") {
        authenticationUrls.push(url.href);
        return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Anmeldung</title>" });
      }
      if (url.origin !== origin || url.pathname === "/" || url.pathname.startsWith("/assets/")) return route.continue();
      const json = async (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (authenticationExpired) return json({ error: "Token ist abgelaufen." }, 401);
      if (url.pathname === "/public-world-contracts") return json([
        worldContract(PUBLIC_WORLD, "Welt A", "a".repeat(64)), worldContract(SECOND_WORLD, "Welt B", "9".repeat(64)),
      ]);
      if (url.pathname === `/worlds/${SECOND_WORLD}/tutorial-sessions/active`) return json({ error: "Keine Tutorialwelt" }, 404);
      if (url.pathname === "/me/operators") return json([
        { id: ownA, worldId: PUBLIC_WORLD, name: "EVU A" }, { id: ownB, worldId: SECOND_WORLD, name: "EVU B" },
      ]);
      if (url.pathname === `/worlds/${SECOND_WORLD}/simulation-time`) return json({ atS: 100 });
      if (url.pathname === `/worlds/${SECOND_WORLD}/operators`) return json([
        { id: ownB, worldId: SECOND_WORLD, name: "EVU B" }, { id: sellerB, worldId: SECOND_WORLD, name: "Verkäufer B" },
      ]);
      if (url.pathname === `/worlds/${SECOND_WORLD}/mailbox`) return json([]);
      if (url.pathname === `/worlds/${SECOND_WORLD}/planning/diagram`) return json({ error: "Noch keine Planung" }, 404);
      if (url.pathname === `/worlds/${SECOND_WORLD}/vehicle-market/listings` && request.method() === "GET") return json({ schemaVersion: "zugfolge-cooperation-page/v1", items: [listing(), comparisonListing], nextCursor: null });
      if (url.pathname.endsWith(`/operators/${ownB}/contracts`) && request.method() === "GET") return json({ schemaVersion: "zugfolge-cooperation-page/v1", items: [], nextCursor: null });
      if (url.pathname.endsWith(`/operators/${ownB}/contracts`) && request.method() === "POST") {
        contractAttempts += 1;
        contractMutationKeys.push(String((request.postDataJSON() as Record<string, unknown>)["idempotencyKey"]));
        if (contractAttempts === 1) return route.abort("connectionfailed");
        return json({ error: "Vertragsdaten wurden serverseitig abgelehnt." }, 400);
      }
      if (url.pathname.endsWith(`/operators/${ownB}/cooperation-resources`)) return json({
        schemaVersion: "zugfolge-cooperation-resource-catalog/v1", worldId: SECOND_WORLD, operatorId: ownB, fleetRevision: null,
        trainRuns: [{ id: "run-browser", label: "RE 12", detail: "Regionalzug" }], connectionTrainRuns: [],
        formations: [{ id: "formation-browser", label: "Formation RE 12", detail: "einsatzbereit" }],
        personnelDuties: [{ id: "duty-browser", label: "Personaldienst RE 12", detail: "gueltig" }],
        pathReceipts: [{ id: "path-browser", label: "Trasse RE 12", detail: "bestaetigt" }],
        disruptions: [], rentableVehicles: [], assistanceVehicles: [],
      });
      if (url.pathname.endsWith(`/operators/${ownB}/vehicles`)) return json([]);
      if (url.pathname === `/worlds/${SECOND_WORLD}/vehicle-market/listings/${listingId}/reserve` && request.method() === "POST") {
        mutationPaths.push(url.pathname);
        mutationKeys.push(String((request.postDataJSON() as Record<string, unknown>)["idempotencyKey"]));
        reserveAttempts += 1;
        if (reserveAttempts === 1) return json({ error: "Reservierung wurde zwischenzeitlich geändert." }, 409);
        reserved = true;
        return json(listing());
      }
      return json({ error: `Unerwarteter E2E-Pfad ${request.method()} ${url.pathname}` }, 500);
    });

    await page.goto(`${origin}/?view=journey&world=${SECOND_WORLD}`, { waitUntil: "networkidle" });
    await page.getByText("Handelndes EVU in Welt B").waitFor();
    expect(await page.locator(".m12-toolbar").innerText()).toContain("EVU B");
    const worldSnapshot = await page.locator(".world-contracts").ariaSnapshot();
    for (const text of ["Welt A", "Welt B", "Dauerhaft, keine Wipes", "Fahrplanperiode", "Startkapital", "Eintrittsfenster"]) expect(worldSnapshot).toContain(text);
    const comparison = page.locator(".comparison-scroll");
    await tabUntil(page, ".comparison-scroll");
    expect(await comparison.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await comparison.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => comparison.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    const term = page.getByRole("button", { name: "Trasse", exact: true }).first();
    await term.click();
    expect(await page.locator(".zf-glossary__dialog").ariaSnapshot()).toContain("Trasse");
    await page.getByRole("button", { name: "Schließen" }).click();
    expect(await term.evaluate((element) => document.activeElement === element)).toBe(true);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.getByRole("navigation", { name: "Hauptnavigation" }).isVisible()).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const [actionBox, glossaryBox] = await Promise.all([
      page.getByRole("button", { name: "10 Minuten reservieren" }).boundingBox(),
      page.locator(".zf-glossary__opener").boundingBox(),
    ]);
    expect(actionBox).not.toBeNull();
    expect(glossaryBox).not.toBeNull();
    expect(glossaryBox!.y).toBeGreaterThanOrEqual(actionBox!.y + actionBox!.height);
    await page.locator('input[name="trainRunIds"]').check();
    await page.locator('input[name="formationIds"]').check();
    await page.locator('input[name="personnelDutyIds"]').check();
    await page.locator('input[name="pathReceiptIds"]').check();
    await page.locator('input[name="termsSummary"]').fill("Browserentwurf bleibt erhalten");
    for (const expectedAttempt of [1, 2]) {
      await page.locator("#m12-contract-form button[type=submit]").click();
      await page.getByRole("button", { name: "Verbindlich bestätigen" }).click();
      await expect.poll(() => contractAttempts).toBe(expectedAttempt);
      await page.locator(".journey-message--error").waitFor();
      expect(await page.locator(".journey-message--error").evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await page.locator('input[name="termsSummary"]').inputValue()).toBe("Browserentwurf bleibt erhalten");
    }
    expect(new Set(contractMutationKeys).size).toBe(1);
    const reserveTrigger = page.getByRole("button", { name: "10 Minuten reservieren" });
    await reserveTrigger.click();
    const detail = await page.locator("#confirmation-detail").innerText();
    for (const label of ["Welt:", "Parteien:", "Objekt:", "Betrag:", "Frist:", "Folgen:"]) expect(detail).toContain(label);
    expect(await page.getByRole("button", { name: "Abbrechen" }).evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.press("Shift+Tab");
    expect(await page.locator("#journey-confirmation").evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    expect(mutationPaths).toHaveLength(0);
    expect(await reserveTrigger.evaluate((element) => document.activeElement === element)).toBe(true);
    await reserveTrigger.click();
    await page.getByRole("button", { name: "Verbindlich bestätigen" }).click();
    const error = page.locator(".journey-message--error");
    await error.waitFor();
    expect(await error.innerText()).toContain("zwischenzeitlich geändert");
    expect(await error.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.getByRole("button", { name: "10 Minuten reservieren" }).click();
    await page.getByRole("button", { name: "Verbindlich bestätigen" }).click();
    await expect.poll(() => mutationPaths.length).toBe(2);
    expect(mutationPaths).toEqual(Array(2).fill(`/worlds/${SECOND_WORLD}/vehicle-market/listings/${listingId}/reserve`));
    expect(new Set(mutationKeys).size).toBe(1);
    expect(mutationPaths.some((path) => path.includes(PUBLIC_WORLD))).toBe(false);
    expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
    authenticationExpired = true;
    await page.getByRole("button", { name: "Kooperation und Markt aktualisieren" }).click();
    const authenticationError = page.locator(".journey-message--error");
    await authenticationError.waitFor();
    expect(await authenticationError.innerText()).toContain("Anmeldung erforderlich");
    expect(await authenticationError.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.getByRole("button", { name: "Anmeldung neu beginnen" }).click();
    await expect.poll(() => authenticationUrls.length).toBe(1);
    const authorization = new URL(authenticationUrls[0]!);
    expect(authorization.pathname).toContain("/protocol/openid-connect/auth");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("redirect_uri")).toContain(`world=${SECOND_WORLD}`);
  }, 60_000);

  it("erhält Skip-Ziel und Auswahlfokus im Bildfahrplan ausschließlich per Tastatur", async () => {
    const context = await browser!.newContext({ viewport: { width: 768, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${origin}/?demo=1`, { waitUntil: "networkidle" });

    await tabUntil(page, ".skip");
    await page.keyboard.press("Enter");
    expect(await page.locator("#diagram-card").evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await page.locator("#diagram-card").getAttribute("aria-labelledby")).toBe("diagram-title");

    await tabUntil(page, "#density");
    await page.keyboard.press("Enter");
    expect(await page.locator("#density").evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await page.locator("#root").getAttribute("data-density")).toBe("document");

    await tabUntil(page, '[data-train="demo-t1"]');
    await page.keyboard.press("Enter");
    expect(await page.locator('[data-train="demo-t1"]').evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await page.locator('[data-train="demo-t1"]').getAttribute("aria-pressed")).toBe("true");

    await tabUntil(page, '[data-conflict="demo-conflict-opposing"]');
    await page.keyboard.press("Enter");
    expect(await page.locator('[data-conflict="demo-conflict-opposing"]').evaluate((element) => document.activeElement === element)).toBe(true);

    await tabUntil(page, "[data-apply-alternative]");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator("#diagram-card").evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await page.locator(".notice").innerText()).toContain("bestätigte Planungsstand");
  }, 60_000);
});
