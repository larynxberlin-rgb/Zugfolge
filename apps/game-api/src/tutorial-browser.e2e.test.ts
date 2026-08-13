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
import { chromium, type Browser } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAlphaRoutes } from "./alpha-routes.js";
import { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import { GameTutorialWorldFactory } from "./tutorial-world-factory.js";

const PUBLIC_WORLD = "00000000-0000-4000-8000-000000000121";
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

    const reference = (await page.locator(".tutorial-experience > header .eyebrow").innerText()).match(/tut_[a-z2-7]+/)?.[0];
    expect(reference).toMatch(/^tut_[a-z2-7]{20,52}$/);
    expect(await page.locator("#lutz-name").evaluate((element) => document.activeElement === element)).toBe(true);
    await page.getByRole("button", { name: "Ausschreibung öffnen" }).click();
    expect(await page.locator("#tutorial-chapter-1").evaluate((element) => document.activeElement === element)).toBe(true);
    const [taskBox, coachBox] = await Promise.all([page.locator(".tutorial-task").boundingBox(), page.locator(".tutorial-coach").boundingBox()]);
    expect(taskBox).not.toBeNull();
    expect(coachBox).not.toBeNull();
    expect(coachBox!.x).toBeGreaterThanOrEqual(taskBox!.x + taskBox!.width);
    expect(await page.locator(".tutorial-coach").evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Ein tragfähiges Angebot abgeben" }).waitFor();
    expect(await page.locator(".tutorial-experience > header .eyebrow").innerText()).toContain(reference!);

    await page.getByLabel("Bestellerentgelt je Zug-km").fill("1450");
    await page.getByLabel("Pünktlichkeitsversprechen").fill("9200");
    await page.getByLabel("Zusätzliche Sitzplätze").fill("12");
    await page.getByRole("button", { name: "Angebot verbindlich abgeben" }).click();
    await page.getByRole("heading", { name: "Ein Fahrzeug selbst leasen" }).waitFor();
    await page.locator('[data-tutorial-offer="lease-economy"]').click();
    await page.getByRole("heading", { name: "Eine berechnete Trasse bestätigen" }).waitFor();
    await page.locator('[data-tutorial-path="path-robust"]').click();
    await page.getByRole("heading", { name: "Eine Regel ändern und aktivieren" }).waitFor();
    await page.getByLabel("Vorlage").selectOption("connections");
    await page.getByLabel("Entscheidungsregel").selectOption("hold-connections");
    await page.getByLabel("Regelschwelle in Sekunden").fill("240");
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
    expect(publicCard).toContain("Keine Startausstattung");
    expect(publicCard).toContain("signierten Weltentwurf");
  }, 60_000);
});
