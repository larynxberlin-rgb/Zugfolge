import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = dirname(fileURLToPath(import.meta.url));
const STATIC = new Map([
  ["/", ["preview.html", "text/html; charset=utf-8"]],
  ["/preview.css", ["preview.css", "text/css; charset=utf-8"]],
  ["/preview.mjs", ["preview.mjs", "text/javascript; charset=utf-8"]],
  ["/brand.svg", ["../../docs/brand/zugfolge-rail-mark.svg", "image/svg+xml"]],
]);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const validId = (value) => typeof value === "string" && ID.test(value);
const HASH = /^[0-9a-f]{64}$/;
const FIELDS = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const POINT = (value) => FIELDS(value, ["vehicleId", "bodyId", "deckId", "xMm", "yMm"]) && validId(value.vehicleId) && validId(value.bodyId) && ["main", "lower", "upper"].includes(value.deckId) && [value.xMm, value.yMm].every((n) => Number.isSafeInteger(n) && n >= 0);

async function jsonBody(request) {
  if (request.headers["content-type"] !== "application/json") throw Object.assign(new Error(), { code: "preview_content_type_invalid" });
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw Object.assign(new Error(), { code: "preview_request_too_large" });
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw Object.assign(new Error(), { code: "preview_json_invalid" }); }
}

function checkInput(kind, value) {
  const fields = kind === "path" ? ["expectedLayoutHash", "fromNodeId", "toNodeId", "wheelchair"] : ["expectedLayoutHash", "from", "to", "transitionEdgeId", "wheelchair"];
  const valid = FIELDS(value, fields) && typeof value.expectedLayoutHash === "string" && HASH.test(value.expectedLayoutHash) && typeof value.wheelchair === "boolean" &&
    (kind === "path" ? validId(value.fromNodeId) && validId(value.toNodeId) : POINT(value.from) && POINT(value.to) && (value.transitionEdgeId === null || validId(value.transitionEdgeId)));
  if (!valid) throw Object.assign(new Error(), { code: "preview_input_invalid" });
}

/** Lokales Prüfwerkzeug. Der Backendadapter hält M5, Layout und Atlas selbst. */
export async function startInteriorPreviewServer({ port = 4187, backend } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !backend) throw new Error("preview_configuration_invalid");
  const catalog = await backend.listCases();
  if (catalog.schemaVersion !== "conductor-interior-preview-cases/v1" || !Array.isArray(catalog.cases) || !catalog.cases.every((entry) => validId(entry.id)) || new Set(catalog.cases.map((entry) => entry.id)).size !== catalog.cases.length) throw new Error("preview_catalog_invalid");
  const caseIds = new Set(catalog.cases.map((entry) => entry.id));
  const fileIds = new Set(catalog.art.manifest.files.map((file) => file.id));
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status, type, bytes) => { response.writeHead(status, { "Content-Type": type }); response.end(request.method === "HEAD" ? undefined : bytes); };
    const json = (status, value) => send(status, "application/json; charset=utf-8", JSON.stringify(value));
    try {
      const host = request.headers.host;
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host ?? "")) return json(403, { issue: { code: "preview_local_only" } });
      if (request.headers.origin && request.headers.origin !== `http://${host}`) return json(403, { issue: { code: "preview_origin_invalid" } });
      const path = request.url ?? "";
      if (!path.startsWith("/") || /[%\\\0?]/.test(path) || path.split("/").includes("..")) return json(404, { issue: { code: "preview_route_missing" } });
      if (["GET", "HEAD"].includes(request.method)) {
        if (STATIC.has(path)) {
          const [file, type] = STATIC.get(path);
          return send(200, type, await readFile(resolve(TOOL, file)));
        }
        if (path === "/api/cases") return json(200, catalog);
        const art = /^\/api\/art\/([a-zA-Z0-9._:-]+)$/.exec(path);
        if (art && fileIds.has(art[1])) return send(200, "image/png", await backend.artFile(art[1]));
        const layout = /^\/api\/cases\/([a-zA-Z0-9._:-]+)\/layout$/.exec(path);
        if (layout && caseIds.has(layout[1])) return json(200, await backend.loadCase(layout[1]));
      } else if (request.method === "POST") {
        const route = /^\/api\/cases\/([a-zA-Z0-9._:-]+)\/(path|movement)$/.exec(path);
        if (route && caseIds.has(route[1])) {
          const input = await jsonBody(request);
          checkInput(route[2], input);
          return json(200, await (route[2] === "path" ? backend.findPath(route[1], input) : backend.checkMovement(route[1], input)));
        }
      } else return json(405, { issue: { code: "preview_method_invalid" } });
      return json(404, { issue: { code: "preview_route_missing" } });
    } catch (error) {
      const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(error.code) ? error.code : "preview_backend_failed";
      return json(code.startsWith("preview_") && code !== "preview_backend_failed" ? 400 : 409, { issue: { code } });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", accept); });
  return server;
}
