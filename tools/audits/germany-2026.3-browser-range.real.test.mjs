import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import {
  runBrowserNetworkIsolationNegativeProbe,
  runGermany20263BrowserRangeAudit,
} from "./germany-2026.3-browser-range-audit.mjs";

const chromePath = process.env.ZUGFOLGE_BROWSER_QA_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function requireRealPrerequisite(path, label) {
  try {
    await access(path);
  } catch (error) {
    throw new Error(`Expliziter Deutschland-2026.3-Browser-Realtest braucht ${label}; fehlender Pfad: ${path}.`, { cause: error });
  }
}

await requireRealPrerequisite(chromePath, "eine lokale Chrome-/Chromium-Programmdatei");
await requireRealPrerequisite(new URL("../../var/source-cache/annual-2026-pinned/welt-mit-deutschland-detail-2026-08-12-c766073e55b99b213276328e504cbb7a69b0b65db0546adf484539c3bd319aed.pmtiles", import.meta.url), "die gepinnte Basemap");
await requireRealPrerequisite(new URL("../../var/derived/germany-2026.3/map-release-free-v2/infra-deutschland-2026.3.pmtiles", import.meta.url), "die aktuelle Clean-v2-Infrastruktur-PMTiles");
await requireRealPrerequisite(new URL("../../var/derived/germany-2026.3/map-release-free-v2/style.json", import.meta.url), "den aktuellen Clean-v2-Style");

test("prüft die vollständigen Clean-v2-Bytes und rendert den Leipziger Prüfausschnitt in Headless Chrome über HTTP-Ranges", {
  timeout: 120_000,
}, async (context) => {
  const audit = await runGermany20263BrowserRangeAudit({ chromePath });
  assert.equal(audit.passed, true);
  assert.equal(audit.rangeProbes.length, 2);
  assert.ok(audit.rangeProbes.every(({ status, acceptRanges }) => status === 206 && acceptRanges === "bytes"));
  assert.ok(audit.browser.browserRangeRequests.basemap > 0);
  assert.ok(audit.browser.browserRangeRequests.infrastructure > 0);
  assert.deepEqual(audit.browser.errors, []);
  assert.deepEqual(audit.browser.externalRequests, []);
  assert.equal(audit.viewportProbe.name, "Leipzig Hauptbahnhof");
  assert.equal(audit.browser.networkPolicy.serviceWorkers, "blocked");
  assert.deepEqual(audit.browser.networkPolicy.blockedRequests, []);
  assert.deepEqual(audit.browser.networkPolicy.failedRequests, []);
  assert.deepEqual(audit.browser.networkPolicy.blockedWebSockets, []);
  assert.deepEqual(audit.browser.networkPolicy.serviceWorkerRegistrations, []);
  assert.deepEqual(audit.browser.networkPolicy.webErrors, []);
  assert.deepEqual(audit.browser.networkPolicy.processGateway.unexpectedBlockedRequests, []);
  assert.equal(audit.http.failedRequests, 0);
  context.diagnostic(JSON.stringify({
    userAgent: audit.browser.userAgent,
    runtimeVersions: audit.browser.runtimeVersions,
    rangeRequests: audit.http.rangeRequests,
    counts: audit.browser.state.counts,
  }));
});

test("erkennt und sperrt externe Fetches aus Dedicated- und Shared-Workern browserweit", {
  timeout: 60_000,
}, async (context) => {
  const proof = await runBrowserNetworkIsolationNegativeProbe({ chromePath });
  assert.equal(proof.passed, true);
  assert.deepEqual(proof.blockedExternalRequests.map(({ url }) => new URL(url).pathname).sort(), ["/dedicated", "/shared"]);
  const enforcement = Object.fromEntries(proof.blockedExternalRequests.map(({ url, enforcement: boundary }) => [new URL(url).pathname, boundary]));
  assert.equal(enforcement["/dedicated"], "playwright-browser-context");
  assert.equal(enforcement["/shared"], "chrome-process-gateway");
  assert.equal(proof.workerResults.dedicated.blocked, true);
  assert.equal(proof.workerResults.shared.blocked, true);
  assert.equal(proof.workerResults.serviceWorker.active, false);
  assert.equal(proof.workerResults.serviceWorker.installing, false);
  assert.equal(proof.workerResults.serviceWorker.waiting, false);
  assert.equal(proof.workerResults.serviceWorker.controlled, false);
  assert.equal(proof.serviceWorkerPolicy, "blocked");
  assert.deepEqual(proof.serviceWorkerRegistrations, []);
  context.diagnostic(JSON.stringify({
    blocked: proof.blockedExternalRequests.map(({ url, resourceType, enforcement: boundary }) => ({ url, resourceType: resourceType ?? null, boundary })),
    serviceWorkerPolicy: proof.serviceWorkerPolicy,
  }));
});
