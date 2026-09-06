/** Local browser proof: unchanged production routes/DOM, real DB and native domain producers. */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "../../apps/game-api/node_modules/fastify/fastify.js";
import { createServer } from "../../apps/livemap/node_modules/vite/dist/node/index.js";
import { createConductorSessionNativeFixture } from "../../apps/game-api/dist/conductor-session.native-fixture.js";
import { registerConductorSessionRoutes } from "../../apps/game-api/dist/conductor-session-routes.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const noControlEffects = {
  async evidence() { return { encounterEvidence: [], controlReceipts: [] }; },
  async apply(_tx, _context, _state, effects) {
    if (effects.length > 0) throw new Error("This browser fixture has no control-domain integration; effects must not succeed.");
  },
};

export async function startConductorSessionBrowserBackend({ control = noControlEffects, sceneEpochUtcTimeOfDayMs, fixtureFactory } = {}) {
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
    const config = { worldId: fixture.access.worldId, operatorId: fixture.access.operatorId, trainRunId: fixture.access.trainRunId, token };
    const html = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native Schaffnerabnahme</title>
      <style>body{margin:0;background:#101419;color:#edf0f3;font:16px system-ui}main{padding:24px}button{font:inherit;padding:12px 18px}p{max-width:70ch}</style>
      <main><h1>Native Abnahmefahrt</h1><p>Fiktive Testinfrastruktur durch echte M5-, Betriebs-, M10- und Sitzungskerne. Temporäre Testsignaturen; keine produktive Weltaktivierung.</p>
      <button id="open-conductor">Schaffnermodus öffnen</button><p id="harness-error" role="alert"></p></main>
      <script type="module">import { openConductorMode } from '/src/conductor-mode.ts'; import { ConductorApi } from '/src/conductor-api.ts';
      const c=${JSON.stringify(config)}; const entry=document.querySelector('#open-conductor');
      entry.addEventListener('click',()=>openConductorMode({api:new ConductorApi('',c.worldId,c.operatorId,c.trainRunId,async()=>c.token),trainLabel:'Abnahmefahrt · drei M5-Wagenkästen',returnFocus:entry}).catch(()=>{document.querySelector('#harness-error').textContent='Die native Abnahme konnte nicht gestartet werden.';}));</script></html>`;
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
      evidence: { source: "Explicit fictional infrastructure and M5 game configurations; real compiler, PGlite, OperationalWorker, M10 DemandService and session core",
        controlIntegration: fixture.control ? "Actual native fare-control, police and ledger integration" : control === noControlEffects ? "Unconfigured: all nonempty control effects fail closed" : "Explicit caller-provided integration",
        worldId: config.worldId, trainRunId: config.trainRunId, compilerOutputSetHash: receipt.outputSetSha256,
        fleetStateHash: fixture.checkpoint.stateHash, authorityReleaseHash: fixture.checkpoint.state.authorityReleaseHash,
        artVerification: "Approved corpus with temporary test signature; no productive key or world activation" },
      async advance(milliseconds) {
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 120000) throw new Error("Invalid explicit proof time step.");
        const next = tail.then(async () => {
          fixture.clock.nowMs += milliseconds;
          await fixture.apply(`browser-proof:advance:${++advanceSequence}`, { type: "advance-to", atMs: fixture.clock.nowMs });
          await fixture.refresh();
          if (fixture.advanceControl) await fixture.advanceControl();
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
