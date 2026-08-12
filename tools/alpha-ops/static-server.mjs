import { createReadStream, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? "4179");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("invalid port");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function runtimeConfiguration() {
  return {
    gameApiUrl: process.env["GAME_API_PUBLIC_URL"] ?? (process.env["GAME_API_INTERNAL_URL"] ? "/api" : ""),
    keycloakUrl: process.env["KEYCLOAK_PUBLIC_URL"] ?? "",
    keycloakRealm: process.env["KEYCLOAK_REALM"] ?? "zugfolge",
    publicWorldId: process.env["ALPHA_PUBLIC_WORLD_ID"] ?? "",
    tutorialWorldId: process.env["ALPHA_TUTORIAL_WORLD_ID"] ?? "",
  };
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const requested = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (requested === "api" || requested.startsWith("api/")) {
    const internal = process.env["GAME_API_INTERNAL_URL"];
    if (!internal) {
      response.writeHead(502).end("game api proxy is not configured");
      return;
    }
    const upstreamUrl = new URL(`${url.pathname.slice(4)}${url.search}`, internal.endsWith("/") ? internal : `${internal}/`);
    const upstream = httpRequest(upstreamUrl, {
      method: request.method,
      headers: { ...request.headers, host: upstreamUrl.host },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => response.writeHead(502).end("game api unavailable"));
    request.pipe(upstream);
    return;
  }
  if (requested === "runtime-config.js") {
    response.writeHead(200, { "content-type": types[".js"], "cache-control": "no-store" });
    response.end(`globalThis.__ZUGFOLGE_RUNTIME_CONFIG__=${JSON.stringify(runtimeConfiguration())};\n`);
    return;
  }
  const relative = requested === ""
    ? "index.html"
    : requested === "four-eyes-preview.html"
    ? "odoo/addons/zugfolge_admin/static/tests/admin-preview.html"
    : requested;
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  try {
    if (!statSync(path).isFile()) throw new Error("not file");
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(path).pipe(response);
  } catch {
    const index = resolve(root, "index.html");
    if (extname(path) === "" && index.startsWith(`${root}${sep}`)) {
      response.writeHead(200, { "content-type": types[".html"], "cache-control": "no-store" });
      createReadStream(index).pipe(response);
      return;
    }
    response.writeHead(404).end("not found");
  }
}).listen(port, process.env["HOST"] ?? "0.0.0.0", () => process.stdout.write(`static server http://127.0.0.1:${port}\n`));
