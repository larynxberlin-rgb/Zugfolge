import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { startInteriorPreviewServer } from "./server.mjs";

/** Ausschließlich HTTP-Negativfixture; kein erzeugtes oder freigegebenes Layout. */
async function fixture() {
  const calls = [];
  const server = await startInteriorPreviewServer({ port: 0, backend: {
    listCases: () => ({ schemaVersion: "conductor-interior-preview-cases/v1", cases: [{ id: "missing-config", label: "HTTP-Negativfall", description: "Kein Layout." }], art: { manifest: { files: [] } }, evidence: {} }),
    loadCase: (id) => { calls.push(["load", id]); return { issue: { code: "vehicle_configuration_missing", message: "Konfigurationsbeleg fehlt." }, evidence: {} }; },
    findPath: (id, input) => { calls.push(["path", id, input]); throw Object.assign(new Error("Private path C:/not-public-and-secret"), { code: "vehicle_configuration_missing" }); },
    checkMovement: (id, input) => { calls.push(["movement", id, input]); throw new Error("Private backend content must not be returned"); },
    artFile: () => { throw new Error("No art resources in this negative fixture"); },
  } });
  return { server, url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) };
}

test("Lokaler Adapter zeigt echte Ablehnungen und gibt ausschließlich erlaubte Dateien aus", async () => {
  const f = await fixture();
  try {
    const page = await fetch(f.url); assert.equal(page.status, 200); assert.match(await page.text(), /keine laufende Schaffnersitzung/);
    const denied = await fetch(`${f.url}/api/cases/missing-config/layout`);
    assert.equal(denied.status, 200); assert.equal((await denied.json()).issue.code, "vehicle_configuration_missing");
    for (const path of ["/server.mjs", "/native-backend.mjs", "/api/art/unknown", "/api/cases/foreign/layout", "/%2e%2e/package.json"]) assert.equal((await fetch(`${f.url}${path}`)).status, 404);
    const foreignHostStatus = await new Promise((accept, reject) => { const request = get(`${f.url}/api/cases`, { headers: { Host: "foreign.invalid" } }, (response) => { response.resume(); accept(response.statusCode); }); request.on("error", reject); });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(`${f.url}/api/cases`, { headers: { Origin: "https://foreign.invalid" } })).status, 403);
    assert.equal((await fetch(`${f.url}/api/cases`, { method: "DELETE" })).status, 405);
  } finally { await f.close(); }
});

test("Browser kann weder eigenes Layout noch zusätzliche Felder oder ungültige Punkte einspeisen", async () => {
  const f = await fixture();
  const input = { expectedLayoutHash: "a".repeat(64), fromNodeId: "entry", toNodeId: "target", wheelchair: false };
  const post = (path, body, headers = { "Content-Type": "application/json" }) => fetch(`${f.url}/api/cases/missing-config/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    for (const changed of [{ ...input, layout: {} }, { ...input, fromNodeId: null }, { ...input, expectedLayoutHash: "unknown" }, { ...input, wheelchair: "false" }]) {
      const response = await post("path", changed); assert.equal(response.status, 400); assert.equal((await response.json()).issue.code, "preview_input_invalid");
    }
    const point = { vehicleId: "1", bodyId: "body", deckId: "main", xMm: 100, yMm: 500 };
    for (const changed of [{ ...point, xMm: -1 }, { ...point, xMm: 1.5 }, { ...point, deckId: "ghost" }, { ...point, vehicleId: 1 }]) {
      assert.equal((await post("movement", { expectedLayoutHash: input.expectedLayoutHash, from: point, to: changed, transitionEdgeId: null, wheelchair: false })).status, 400);
    }
    assert.equal((await post("path", input, { "Content-Type": "text/plain" })).status, 400);
    assert.equal(f.calls.length, 0);
    const deniedPath = await post("path", input);
    assert.equal(deniedPath.status, 409); assert.deepEqual(await deniedPath.json(), { issue: { code: "vehicle_configuration_missing" } });
    const deniedMovement = await post("movement", { expectedLayoutHash: input.expectedLayoutHash, from: point, to: point, transitionEdgeId: null, wheelchair: false });
    assert.equal(deniedMovement.status, 409); assert.deepEqual(await deniedMovement.json(), { issue: { code: "preview_backend_failed" } });
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});
