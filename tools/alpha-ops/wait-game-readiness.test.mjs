import assert from "node:assert/strict";
import test from "node:test";

import { waitForGameReadiness } from "./wait-game-readiness.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("HTTP 200 ohne gueltigen Health-Bericht bestaetigt keine Readiness", async () => {
  for (const report of [undefined, null, {}, { status: "unknown", checks: [] }, { status: "ok" }, { status: "ok", checks: [null] }]) {
    await assert.rejects(waitForGameReadiness({
      baseUrl: "http://game.test:3000",
      fetchImpl: async (url) => new URL(url).pathname === "/health"
        ? jsonResponse(200, { status: "ok" })
        : report === undefined ? new Response("<html>Proxyfehler</html>") : jsonResponse(200, report),
    }), /keinen gueltigen Health-Bericht/u);
  }
  const degraded = { status: "degraded", checks: [{ name: "odoo", status: "degraded" }] };
  assert.deepEqual(await waitForGameReadiness({
    baseUrl: "http://game.test:3000",
    fetchImpl: async (url) => jsonResponse(200, new URL(url).pathname === "/health" ? { status: "ok" } : degraded),
  }), degraded);
});

test("haengende Health-Anfragen und Antwortkoerper werden innerhalb des Budgets abgebrochen", { timeout: 2_000 }, async () => {
  for (const hangAt of ["headers", "body"]) {
    let requestSignal;
    await assert.rejects(waitForGameReadiness({
      baseUrl: "http://game.test:3000",
      maximumWaitMs: 500,
      requestTimeoutMs: 15,
      fetchImpl: async (url, { signal }) => {
        if (new URL(url).pathname === "/health") return jsonResponse(200, { status: "ok" });
        requestSignal = signal;
        if (hangAt === "headers") return new Promise(() => undefined);
        return { ok: true, json: () => new Promise(() => undefined) };
      },
    }), /Zeitlimit/u);
    assert.equal(requestSignal.aborted, true);
  }
});

test("fortschreitender Cold-Catch-up darf 230 Sekunden ueberschreiten und endet erst bei Readiness", async () => {
  let nowMs = 0;
  const progress = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/health") return jsonResponse(200, { status: "ok" });
    if (path === "/metrics") {
      assert.equal(new URL(url).port, "9464");
      return new Response([
        "zugfolge_regional_simulation_scheduler_running 1",
        "zugfolge_regional_simulation_scheduler_progress_age_seconds 5",
      ].join("\n"));
    }
    if (path === "/health/ready" && nowMs <= 240_000) {
      return jsonResponse(503, {
        status: "down",
        checks: [{
          name: "regional-simulation-scheduler",
          status: "down",
          code: "scheduler_catching_up",
        }],
      });
    }
    return jsonResponse(200, { status: "ok", checks: [] });
  };

  await assert.doesNotReject(waitForGameReadiness({
    baseUrl: "http://game.test:3000",
    maximumWaitMs: 350_000,
    pollIntervalMs: 60_000,
    fetchImpl,
    now: () => nowMs,
    sleep: async (durationMs) => { nowMs += durationMs; },
    onProgress: (entry) => progress.push(entry),
  }));
  assert.ok(nowMs > 230_000);
  assert.ok(progress.length >= 4);
});

test("stagnierender Catch-up und fremder Down-Check scheitern fail-closed", async () => {
  const catchingUpFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/health") return jsonResponse(200, { status: "ok" });
    if (path === "/metrics") {
      return new Response([
        "zugfolge_regional_simulation_scheduler_running 1",
        "zugfolge_regional_simulation_scheduler_progress_age_seconds 121",
      ].join("\n"));
    }
    return jsonResponse(503, {
      status: "down",
      checks: [{
        name: "regional-simulation-scheduler",
        status: "down",
        code: "scheduler_catching_up",
      }],
    });
  };
  await assert.rejects(
    waitForGameReadiness({
      baseUrl: "http://game.test:3000",
      fetchImpl: catchingUpFetch,
      sleep: async () => undefined,
    }),
    /keinen aktuellen Schedulerfortschritt/u,
  );

  const databaseDownFetch = async (url) => new URL(url).pathname === "/health"
    ? jsonResponse(200, { status: "ok" })
    : jsonResponse(503, {
        status: "down",
        checks: [{ name: "postgres", status: "down", code: "database_unavailable" }],
      });
  await assert.rejects(
    waitForGameReadiness({
      baseUrl: "http://game.test:3000",
      fetchImpl: databaseDownFetch,
      sleep: async () => undefined,
    }),
    /database_unavailable/u,
  );
});
