/** Local browser proof: unchanged production routes/DOM, real DB and native domain producers. */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "../../apps/game-api/node_modules/fastify/fastify.js";
import { createServer } from "../../apps/livemap/node_modules/vite/dist/node/index.js";
import { createConductorSessionNativeFixture } from "../../apps/game-api/dist/conductor-session.native-fixture.js";
import { registerConductorSessionRoutes } from "../../apps/game-api/dist/conductor-session-routes.js";
import { loadConductorContext } from "../../apps/game-api/dist/conductor-context.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const nativeTransport = process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH ? "native-napi" : "native-rust-cli";
const configuredNativePaths = nativeTransport === "native-napi" ? [process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH]
  : ["ZUGFOLGE_FLEET_TEST_BINARY", "ZUGFOLGE_OPERATIONAL_TEST_BINARY", "ZUGFOLGE_INTERIOR_TEST_BINARY",
    "ZUGFOLGE_DEMAND_TEST_BINARY", "ZUGFOLGE_SESSION_TEST_BINARY", "ZUGFOLGE_DIALOGUE_TEST_BINARY",
    "ZUGFOLGE_FARE_CONTROL_TEST_BINARY"].map((key) => process.env[key]).filter(Boolean);
const nativeBuildProfile = configuredNativePaths.length && configuredNativePaths.every((path) => /[\\/]release[\\/]/u.test(path)) ? "release"
  : configuredNativePaths.length && configuredNativePaths.every((path) => /[\\/]debug[\\/]/u.test(path)) ? "debug" : "mixed-or-unspecified";
const noControlEffects = {
  async evidence() { return { encounterEvidence: [], controlReceipts: [] }; },
  async apply(_tx, _context, _state, effects) {
    if (effects.length > 0) throw new Error("This browser fixture has no control-domain integration; effects must not succeed.");
  },
};

export async function startConductorSessionBrowserBackend({ control = noControlEffects, sceneEpochUtcTimeOfDayMs, fixtureFactory, entryOnly = false } = {}) {
  const fixture = fixtureFactory ? await fixtureFactory() : await createConductorSessionNativeFixture(control, { sceneEpochUtcTimeOfDayMs });
  const app = Fastify({ logger: false }), token = randomBytes(24).toString("hex");
  const streams = new Set(), requests = [];
  let vite, closed = false, advanceSequence = 0, tail = Promise.resolve();
  try {
    app.decorateRequest("identity", null);
    app.addHook("onRequest", async (request, reply) => {
      requests.push({ method: request.method, path: request.url.split("?")[0] });
      if (request.url.includes("/events")) { streams.add(reply.raw); reply.raw.on("close", () => streams.delete(reply.raw)); }
    });
    registerConductorSessionRoutes(app, { conductorSessions: fixture.sessions, async authenticate(request, reply) {
      if (request.headers.authorization !== `Bearer ${token}`) { await reply.code(401).send({ code: "test_token_invalid", error: "Lokaler Prüftoken fehlt." }); return; }
      request.identity = { keycloakSubject: fixture.access.keycloakSubject, displayName: "Native Browserabnahme" };
    } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const apiOrigin = `http://127.0.0.1:${app.server.address().port}`;
    const world = await fixture.db.query.worlds.findFirst({ where: (row, { eq }) => eq(row.id, fixture.access.worldId) });
    const operator = await fixture.db.query.operators.findFirst({ where: (row, { eq, and }) => and(eq(row.worldId, fixture.access.worldId), eq(row.id, fixture.access.operatorId)) });
    if (!world || !operator) throw new Error("The actual browser fixture requires its world and operator names.");
    const config = { worldId: fixture.access.worldId, operatorId: fixture.access.operatorId, trainRunId: fixture.access.trainRunId,
      worldLabel: world.name, operatorLabel: operator.name, token };
    let html = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native Schaffnerabnahme</title>
      <style>body{margin:0;background:#101419;color:#edf0f3;font:16px system-ui}main{padding:24px}button{font:inherit;padding:12px 18px}p{max-width:70ch}</style>
      <main><h1>Native Abnahmefahrt</h1><p>Fiktive Testinfrastruktur durch echte M5-, Betriebs-, M10- und Sitzungskerne. Temporäre Testsignaturen; keine produktive Weltaktivierung.</p>
      <button id="open-conductor">Schaffnermodus öffnen</button><button id="open-control-report">Kontrollbericht öffnen</button><p id="harness-error" role="alert"></p></main>
      <script type="module">import { openConductorMode } from '/src/conductor-mode.ts'; import { ConductorApi } from '/src/conductor-api.ts'; import { openConductorReport } from '/src/conductor-report.ts';
      const c=${JSON.stringify(config)}; const entry=document.querySelector('#open-conductor');
      const api=new ConductorApi('',c.worldId,c.operatorId,c.trainRunId,async()=>c.token); const reportEntry=document.querySelector('#open-control-report');
      entry.addEventListener('click',()=>openConductorMode({api,trainLabel:'Abnahmefahrt · drei M5-Wagenkästen',worldLabel:c.worldLabel,operatorLabel:c.operatorLabel,returnFocus:entry}).catch(()=>{document.querySelector('#harness-error').textContent='Die native Abnahme konnte nicht gestartet werden.';}));
      reportEntry.addEventListener('click',()=>openConductorReport({api,trainLabel:'Abnahmefahrt · drei M5-Wagenkästen',returnFocus:reportEntry}));</script></html>`;
    if (entryOnly) {
      const companies = await fixture.db.query.operators.findMany({ where: (row, { eq }) => eq(row.worldId, fixture.access.worldId) });
      const entryConfig = { ...config, operatorLabels: Object.fromEntries(companies.map((row) => [row.id, row.name])),
        trainLabels: Object.fromEntries(fixture.initialization.trains.map((row) => [row.id, row.trainNumber])) };
      html = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nativer Zugdetail-Einstieg</title>
        <style>body{margin:0;background:#101419;color:#edf0f3;font:16px system-ui}main{padding:24px}button{font:inherit;padding:12px 18px;margin:4px}p{max-width:70ch}.conductor-entry{border:1px solid #71808e;padding:20px;max-width:700px}</style>
        <main><h1>Nativer Zugdetail-Einstieg</h1><p>Originale Einstiegskomponente mit tatsächlicher Betriebsfahrt und API. Diese Komponentenumgebung bildet keine Karte nach.</p>
        <section id="entry-detail"><h2 id="entry-train"></h2><p id="entry-context"></p><div id="entry-host"></div></section>
        <button id="leave-selection">Auswahl verlassen</button></main>
        <script type="module">import { appendConductorEntry } from '/src/conductor-entry.ts'; import { ConductorApi } from '/src/conductor-api.ts';
        const c=${JSON.stringify(entryConfig)}, requested=new URLSearchParams(location.hash.slice(1));
        const operatorId=requested.get('operatorId')??c.operatorId, trainRunId=requested.get('trainRunId')??c.trainRunId;
        const trainLabel=c.trainLabels[trainRunId]??'Unbekannte Prüffahrt', operatorLabel=c.operatorLabels[operatorId]??'Unbekanntes Unternehmen';
        const detail=document.querySelector('#entry-detail'); Object.assign(detail.dataset,{worldId:c.worldId,operatorId,trainRunId});
        document.querySelector('#entry-train').textContent=trainLabel; document.querySelector('#entry-context').textContent=c.worldLabel+' · '+operatorLabel;
        let selected=true; document.querySelector('#leave-selection').addEventListener('click',()=>{selected=false;detail.dataset.selection='left';});
        const api=new ConductorApi('',c.worldId,operatorId,trainRunId,async()=>c.token);
        void appendConductorEntry({host:document.querySelector('#entry-host'),api,trainLabel,worldLabel:c.worldLabel,operatorLabel,isCurrent:()=>selected});</script></html>`;
    }
    vite = await createServer({ root: resolve(ROOT, "apps/livemap"), configFile: false, logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { strict: true, allow: [ROOT] },
        proxy: { "/worlds": { target: apiOrigin, changeOrigin: false } } },
      plugins: [{ name: "actual-conductor-component-proof", configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/" && request.url !== "/conductor-proof") return next();
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(html);
        });
      } }],
    });
    await vite.listen();
    const url = `http://127.0.0.1:${vite.httpServer.address().port}/conductor-proof`;
    const route = `/worlds/${config.worldId}/operators/${config.operatorId}/trains/${config.trainRunId}/conductor-sessions`;
    const receipt = JSON.parse(await readFile(resolve(fixture.compiled.output, "vehicle-catalog-compile-receipt-v4.json"), "utf8"));
    return {
      url, route, token, fixture,
      async throughPassengerKeys() {
        // Node-only target selection for a path that spans the actual middle
        // arrival. Journey metadata is never sent to the page or its API.
        const context = await loadConductorContext(fixture.db, fixture.access, fixture.dependencies);
        const finalStopId = fixture.initialization.trains[0].stopPlan.stops.at(-1).stopId;
        return [...new Set(context.projectionInput.evaluation.manifests.filter((manifest) => manifest.trainRunId === config.trainRunId)
          .flatMap((manifest) => manifest.passengers.filter((person) => person.alightingStopId === finalStopId).map((person) => person.passengerKey)))];
      },
      evidence: { source: "Explicit fictional infrastructure and M5 game configurations; real compiler, PGlite, OperationalWorker, M10 DemandService and session core",
        nativeTransport, nativeBuildProfile, nativeBuildProfileEvidence: "Inferred from explicitly configured native program paths",
        controlIntegration: fixture.control ? "Actual native fare-control, police and ledger integration" : control === noControlEffects ? "Unconfigured: all nonempty control effects fail closed" : "Explicit caller-provided integration",
        worldId: config.worldId, trainRunId: config.trainRunId, compilerOutputSetHash: receipt.outputSetSha256,
        demandFinalitySteps: fixture.demandFinalitySteps ?? [],
        fleetStateHash: fixture.checkpoint.stateHash, authorityReleaseHash: fixture.checkpoint.state.authorityReleaseHash,
        artVerification: "Approved corpus with temporary test signature; no productive key or world activation" },
      async advance(milliseconds) {
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 86_400_000) throw new Error("Invalid explicit proof time step.");
        const next = tail.then(async () => {
          fixture.clock.nowMs += milliseconds;
          await fixture.apply(`browser-proof:advance:${++advanceSequence}`, { type: "advance-to", atMs: fixture.clock.nowMs });
          if (fixture.refreshConductorCycle) await fixture.refreshConductorCycle();
          else await fixture.refresh();
        });
        tail = next.catch(() => {}); return next;
      },
      async advanceForReport(atMs) {
        const finalEvidenceAtMs = fixture.settlementReadyAtMs ?? 86_400_001;
        if (!fixture.advanceControl || !Number.isSafeInteger(finalEvidenceAtMs) || !Number.isSafeInteger(atMs)
          || atMs <= fixture.clock.nowMs || atMs > Math.max(86_400_001, finalEvidenceAtMs)) throw new Error("Invalid explicit report time boundary.");
        const next = tail.then(async () => {
          fixture.clock.nowMs = atMs;
          await fixture.apply(`browser-proof:report:${++advanceSequence}`, { type: "advance-to", atMs });
          // Historical cases keep their native tariff pins. A completed day
          // needs no new passenger manifest or synthetic settlement command.
          await fixture.advanceControl();
        });
        tail = next.catch(() => {}); return next;
      },
      disconnectStreams() { for (const stream of streams) stream.destroy(); vite.httpServer.closeAllConnections(); },
      requestSummary: () => requests.map((request) => ({ ...request })),
      async close() {
        if (closed) return; closed = true;
        for (const stream of streams) stream.destroy();
        await tail; await vite.close(); await app.close(); await fixture.dispose();
      },
    };
  } catch (error) {
    await vite?.close(); for (const stream of streams) stream.destroy(); await app.close(); await fixture.dispose(); throw error;
  }
}
