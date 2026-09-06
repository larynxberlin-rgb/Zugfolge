import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { canonicalizeProgram, type OperatingProgram } from "@zugfolge/dispatch";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const dist = resolve(import.meta.dirname, "../../operations-center/dist");
const base = "/worlds/world/operators/operator";
const initial: OperatingProgram = {
  schema: "operating-program/v1", world_id: "world", operator_id: "operator", version: 1, enabled: true,
  rules: [{ id: "regel-a", priority: 100, enabled: true, trigger: { type: "route_closure" }, condition: { type: "predicate", fact: "route_closed", comparison: "equal", value: { type: "boolean", value: true } }, action: "request_reroute" }],
};
type Version = { version: number; status: string; checksum: string; canonicalProgram: OperatingProgram };
function version(program: OperatingProgram): Version {
  const canonical = canonicalizeProgram(program, { worldId: "world", operatorId: "operator" });
  return { version: program.version, status: "draft", checksum: canonical.checksum, canonicalProgram: canonical.program };
}
function decision(sequence = 1) {
  return { sequence, occurredAt: "2026-01-01T00:00:00.000Z", trainRunId: "train-1", decisionId: "decision-1", action: "request_reroute", cause: "route_closure", causeCode: 26, causeLabel: "Störung", fineCauseId: "switch.drive", fineCauseLabel: "Weiche", affectedResource: "route-1", outcomeReason: "Kapazität", impact: {}, raw: {} };
}

(process.env["ZUGFOLGE_BROWSER_E2E"] === "1" ? describe : describe.skip)("Betriebszentrale im echten Browser (#507/#510)", () => {
  let app: FastifyInstance;
  let browser: Browser;
  let page: Page;
  let origin: string;
  let versions: Version[];
  let activated: Version | undefined;
  let loseSaveResponse: boolean;
  let rejectSave: boolean;
  let sequence: number;
  let decisions: ReturnType<typeof decision>[];
  let streams: Set<ServerResponse>;
  let operationsReads: number;
  let overrideRequests: number;
  let consumerAvailable: boolean;

  beforeEach(async () => {
    versions = [{ ...version(initial), status: "active" }];
    activated = undefined; loseSaveResponse = false; rejectSave = false; sequence = 1;
    decisions = [decision()]; streams = new Set(); operationsReads = 0; overrideRequests = 0;
    consumerAvailable = true;
    app = Fastify();
    const index = readFileSync(resolve(dist, "index.html"), "utf8").replace('<script src="./runtime-config.js"></script>', `<script>globalThis.__ZUGFOLGE_RUNTIME_CONFIG__={publicWorldId:"world"};sessionStorage.setItem("zugfolge.oidc.operations-center.accessToken","browser-test");sessionStorage.setItem("zugfolge.oidc.operations-center.accessTokenExpiresAt",String(Date.now()+3600000));</script>`);
    app.get("/", async (_request, reply) => reply.type("text/html").send(index));
    app.get("/assets/*", async (request, reply) => {
      const path = resolve(dist, "assets", (request.params as { "*": string })["*"]);
      if (!path.startsWith(`${resolve(dist, "assets")}${sep}`) || !existsSync(path)) return reply.code(404).send();
      return reply.type(extname(path) === ".css" ? "text/css" : "text/javascript").send(readFileSync(path));
    });
    app.get(`${base}/operating-programs/templates`, async () => [{ id: "template", name: "Vorlage", program: initial }]);
    app.get(`${base}/operating-programs`, async () => versions);
    app.post(`${base}/operating-programs`, async (request, reply) => {
      const program = (request.body as { program: OperatingProgram }).program;
      if (rejectSave || versions.some((entry) => entry.version === program.version)) return reply.code(409).send({ error: "Diese Betriebsprogramm-Version existiert bereits." });
      const saved = version(program); versions.push(saved);
      if (loseSaveResponse) { loseSaveResponse = false; return reply.code(503).send({ error: "Antwort verloren" }); }
      return saved;
    });
    app.post(`${base}/operating-programs/:version/activate`, async (request) => {
      activated = versions.find((entry) => entry.version === Number((request.params as { version: string }).version));
      if (activated !== undefined) activated.status = "active";
      return {};
    });
    app.get(`${base}/operations`, async () => { operationsReads++; return { consumerAvailable, throughSequence: sequence, decisions, majorEvents: [], manualInterventions: [], cancellations: [] }; });
    app.get(`${base}/operations/reports`, async () => []);
    app.post(`${base}/operations/decisions/:id/override`, async () => { overrideRequests++; return {}; });
    app.get("/worlds/world/me/operator-context", async () => ({ schemaVersion: "zugfolge-operator-context/v1", worldId: "world", operators: [{ id: "operator", name: "Test-EVU", finance: { mode: "unlimited" } }] }));
    app.get(`${base}/operations/events`, async (_request, reply) => {
      reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream" }); reply.raw.write(": verbunden\n\n");
      streams.add(reply.raw); reply.raw.on("close", () => streams.delete(reply.raw));
    });
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const executablePath = [process.env["ZUGFOLGE_BROWSER_EXECUTABLE"], "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => path !== undefined && existsSync(path));
    if (executablePath === undefined) throw new Error("Browser-E2E braucht Chrome oder Chromium.");
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage();
  });
  afterEach(async () => { for (const stream of streams ?? []) stream.end(); await browser?.close(); await app?.close(); });

  async function open(panel: string) {
    await page.goto(`${origin}/?world=world&operator=operator&panel=${panel}`);
    await page.locator("#refresh").waitFor();
    await expect.poll(() => page.locator("#root").innerText()).toContain("Test-EVU");
    await expect.poll(() => streams.size).toBe(1);
  }
  async function event() {
    const previousHeader = await page.locator(".topbar").elementHandle();
    if (previousHeader === null) throw new Error("Betriebszentrale ist vor dem Live-Ereignis nicht sichtbar.");
    const reads = operationsReads; sequence++;
    decisions = [...decisions, { ...decision(sequence), decisionId: `decision-${sequence}` }];
    for (const stream of streams) stream.write(`data: ${JSON.stringify({ decision: { ...decision(), sequence } })}\n\n`);
    await expect.poll(() => operationsReads).toBeGreaterThan(reads);
    // Erst nach dem Live-Neurender prüfen, dass Editor und Dialog erhalten bleiben.
    await expect.poll(() => previousHeader.evaluate((element) => element.isConnected)).toBe(false);
    await previousHeader.dispose();
    if (new URL(page.url()).searchParams.get("panel") === "operations") {
      await expect.poll(() => page.locator(".metrics-strip strong").first().textContent()).toBe(String(decisions.length));
    }
  }

  // Browserreisen besitzen ein eigenes Laufzeitbudget; dies ist kein Latenzbenchmark.
  it("speichert zwei Bearbeitungen als Version 2/3 und aktiviert exakt den sichtbaren Inhalt", { timeout: 30_000 }, async () => {
    await open("program");
    for (const [priority, number] of [[200, 2], [300, 3]]) {
      await page.locator("[data-priority]").fill(String(priority)); await page.locator("[data-priority]").press("Tab");
      expect(await page.locator("#activate-program").isDisabled()).toBe(true);
      expect(await page.locator("#run-backtest").isDisabled()).toBe(true);
      await page.locator("#save-program").click();
      await expect.poll(() => page.locator(".message").textContent()).toContain(`Version ${number} gespeichert`);
      expect(versions.at(-1)?.canonicalProgram.rules[0]?.priority).toBe(priority);
    }
    await page.locator("#save-program").click();
    await expect.poll(() => page.locator("#save-program").isDisabled()).toBe(false);
    expect(versions).toHaveLength(3);
    await page.locator("#activate-program").click();
    await expect.poll(() => activated?.version).toBe(3);
    expect(activated?.canonicalProgram.rules[0]?.priority).toBe(300);
  });

  it("erhält Entwurf bei Konflikt und erkennt ein verlorenes Speicher-Ack", { timeout: 30_000 }, async () => {
    await open("program");
    await page.locator("[data-priority]").fill("250"); await page.locator("[data-priority]").press("Tab");
    rejectSave = true; await page.locator("#save-program").click();
    await expect.poll(() => page.locator(".message").textContent()).toContain("existiert bereits");
    expect(await page.locator("[data-priority]").inputValue()).toBe("250");
    rejectSave = false; loseSaveResponse = true; await page.locator("#save-program").click();
    await expect.poll(() => page.locator(".message").textContent()).toContain("Version 2 gespeichert");
    expect(versions).toHaveLength(2);
    expect(await page.locator("#activate-program").isDisabled()).toBe(false);
  });

  it("erhält Regel-Rohtext und Fokus während eines Stream-Ereignisses vor change", { timeout: 30_000 }, async () => {
    await open("program");
    await page.locator("[data-rule-id-input]").fill("regel-neuer-entwurf");
    await event();
    expect(await page.locator("[data-rule-id-input]").inputValue()).toBe("regel-neuer-entwurf");
    expect(await page.locator("[data-rule-id-input]").evaluate((element) => element === document.activeElement)).toBe(true);
    await page.locator("[data-rule-id-input]").press("Tab");
    await page.locator("#save-program").click();
    await expect.poll(() => versions.at(-1)?.canonicalProgram.rules[0]?.id).toBe("regel-neuer-entwurf");
  });

  it("erhält Dialog, Aktion, Begründung und Auswahl; verwirft geänderte Entscheidung ohne Textverlust", { timeout: 30_000 }, async () => {
    await open("operations");
    expect(await page.locator(".metrics-strip strong").first().textContent()).toBe("1");
    await page.locator("#event-1").focus();
    await event();
    expect(await page.locator("#event-1").evaluate((element) => element === document.activeElement)).toBe(true);
    await page.locator("[data-open-override]").first().click();
    const dialog = page.getByRole("dialog", { name: "Selbst entscheiden" });
    await dialog.waitFor();
    await page.locator("#override-reason").fill("kurz");
    await page.locator("#submit-override").click();
    expect(await page.locator("#override-reason").evaluate((element) => (element as HTMLTextAreaElement).validity.tooShort)).toBe(true);
    expect(overrideRequests).toBe(0);
    await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
    expect(await dialog.count()).toBe(0);
    await page.locator("[data-open-override]").first().click();
    await page.getByRole("button", { name: "Dialog schließen", exact: true }).click();
    expect(await dialog.count()).toBe(0);
    await page.locator("[data-open-override]").first().click();
    await page.locator("#override-action").selectOption("cancel_run");
    await page.locator("#override-reason").fill("Die vollständige Begründung bleibt erhalten.");
    await page.locator("#override-reason").evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(4, 16));
    await event();
    expect(await page.locator("#override-dialog").evaluate((element) => (element as HTMLDialogElement).open)).toBe(true);
    expect(await page.locator("#override-action").inputValue()).toBe("cancel_run");
    expect(await page.locator("#override-reason").evaluate((element) => [element === document.activeElement, (element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([true, 4, 16]);
    decisions = []; await page.locator("#submit-override").click();
    await expect.poll(() => page.locator(".message").textContent()).toContain("nicht mehr verfügbar");
    expect(await page.locator("#override-reason").inputValue()).toBe("Die vollständige Begründung bleibt erhalten.");
    expect(overrideRequests).toBe(0);
  });

  it("bindet verfügbare Programmaktionen an den gemeldeten Weltserverstatus, auch nach einem Livewechsel", { timeout: 30_000 }, async () => {
    consumerAvailable = false;
    await open("program");
    expect(await page.locator(".topbar").textContent()).toContain("Programmausführung nicht verfügbar");
    expect(await page.locator("#activate-program").isDisabled()).toBe(true);
    expect(await page.locator("#run-backtest").isDisabled()).toBe(true);
    expect(await page.locator("#save-program").isDisabled()).toBe(false);
    consumerAvailable = true;
    await event();
    expect(await page.locator("#activate-program").isDisabled()).toBe(false);
    expect(await page.locator(".execution-status").count()).toBe(0);
  });
});
