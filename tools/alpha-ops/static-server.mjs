import { createReadStream, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSingleByteRange } from "./static-range.mjs";

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pmtiles": "application/vnd.pmtiles",
  ".sqlite": "application/vnd.sqlite3",
  ".pbf": "application/x-protobuf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export function runtimeConfiguration(environment = process.env) {
  const releaseId = environment["MAP_RELEASE_ID"] ?? "infra-deutschland-2026.2";
  if (!/^infra-deutschland-[0-9]{4}\.[0-9]+$/u.test(releaseId)) {
    throw new Error("MAP_RELEASE_ID verletzt den versionierten Deutschland-Kartenvertrag.");
  }
  const publicBasePath = `/artifacts/maps/${releaseId}`;
  const mapBasemapStyleUrl = environment["MAP_BASEMAP_STYLE_URL"] ?? `${publicBasePath}/style.json`;
  const mapGermanyPmtilesUrl = environment["MAP_GERMANY_PMTILES_URL"] ?? `${publicBasePath}/${releaseId}.pmtiles`;
  if (mapBasemapStyleUrl !== `${publicBasePath}/style.json`
    || mapGermanyPmtilesUrl !== `${publicBasePath}/${releaseId}.pmtiles`) {
    throw new Error("Kartenpfade und MAP_RELEASE_ID bezeichnen nicht dasselbe installierte Release.");
  }
  return {
    gameApiUrl: environment["GAME_API_PUBLIC_URL"] ?? (environment["GAME_API_INTERNAL_URL"] ? "/api" : ""),
    keycloakUrl: environment["KEYCLOAK_PUBLIC_URL"] ?? "",
    keycloakRealm: environment["KEYCLOAK_REALM"] ?? "zugfolge",
    publicWorldId: environment["ALPHA_PUBLIC_WORLD_ID"] ?? "",
    gameWebUrl: environment["GAME_WEB_PUBLIC_URL"] ?? "",
    livemapUrl: environment["LIVEMAP_PUBLIC_URL"] ?? "",
    livemapOidcClientId: environment["LIVEMAP_OIDC_CLIENT_ID"] ?? "livemap",
    operationsCenterOidcClientId: environment["OPERATIONS_CENTER_OIDC_CLIENT_ID"] ?? "operations-center",
    operationsCenterUrl: environment["OPERATIONS_CENTER_URL"] ?? "",
    mapBasemapStyleUrl,
    mapGermanyPmtilesUrl,
    mapAttribution: environment["MAP_ATTRIBUTION"]
      ?? "© OpenStreetMap-Mitwirkende, ODbL 1.0; Basemap-Aufbereitung Protomaps; weitere Bearbeitung durch Zugfolge",
  };
}

function within(parent, path) {
  return path === parent || path.startsWith(`${parent}${sep}`);
}

function serveFile(request, response, path, immutable) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("not file");
  const headers = {
    "content-type": types[extname(path)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  };
  const range = parseSingleByteRange(request.headers.range, stat.size);
  if (range === null) {
    response.writeHead(416, { ...headers, "content-range": `bytes */${stat.size}` }).end();
    return;
  }
  if (range === undefined) {
    response.writeHead(200, { ...headers, "content-length": stat.size });
    if (request.method === "HEAD") response.end();
    else createReadStream(path).pipe(response);
    return;
  }
  response.writeHead(206, {
    ...headers,
    "content-length": range.end - range.start + 1,
    "content-range": `bytes ${range.start}-${range.end}/${stat.size}`,
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path, { start: range.start, end: range.end }).pipe(response);
}

export function createStaticServer({
  rootDirectory = ".",
  artifactRootDirectory,
  environment = process.env,
} = {}) {
  const root = resolve(rootDirectory);
  const artifactRoot = artifactRootDirectory === undefined
    ? environment["STATIC_ARTIFACT_ROOT"] === undefined
      ? undefined
      : resolve(environment["STATIC_ARTIFACT_ROOT"])
    : resolve(artifactRootDirectory);
  const runtimeConfig = runtimeConfiguration(environment);

  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let requested;
    try {
      requested = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      response.writeHead(400, { "cache-control": "no-store" }).end("invalid path");
      return;
    }

    if (requested === "api" || requested.startsWith("api/")) {
      const internal = environment["GAME_API_INTERNAL_URL"];
      if (!internal) {
        response.writeHead(502).end("game api proxy is not configured");
        return;
      }
      const upstreamUrl = new URL(`${url.pathname.slice(4)}${url.search}`, internal.endsWith("/") ? internal : `${internal}/`);
      const upstream = httpRequest(upstreamUrl, {
        method: request.method,
        // Der Game-API-Hostguard prueft den urspruenglichen Subdomain-Host.
        // Ein interner oder fest erwarteter Ersatzhost wuerde diese Grenze
        // entweder blockieren oder Requests fremder Hosts verschleiern.
        headers: { ...request.headers },
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", () => response.writeHead(502).end("game api unavailable"));
      request.pipe(upstream);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end("method not allowed");
      return;
    }
    if (requested === "runtime-config.js") {
      response.writeHead(200, { "content-type": types[".js"], "cache-control": "no-store" });
      response.end(`globalThis.__ZUGFOLGE_RUNTIME_CONFIG__=${JSON.stringify(runtimeConfig)};\n`);
      return;
    }
    if (requested === "artifacts" || requested.startsWith("artifacts/")) {
      if (artifactRoot === undefined) {
        response.writeHead(503).end("map artifact root is not configured");
        return;
      }
      const artifactRelative = requested.slice("artifacts".length).replace(/^\/+/, "");
      const artifactPath = resolve(artifactRoot, artifactRelative);
      if (!within(artifactRoot, artifactPath)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      try {
        serveFile(request, response, artifactPath, true);
      } catch {
        response.writeHead(404).end("not found");
      }
      return;
    }
    const relative = requested === ""
      ? "index.html"
      : requested === "four-eyes-preview.html"
      ? "odoo/addons/zugfolge_admin/static/tests/admin-preview.html"
      : requested;
    const path = resolve(root, relative);
    if (!within(root, path)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      serveFile(request, response, path, false);
    } catch {
      const index = resolve(root, "index.html");
      if (extname(path) === "" && index.startsWith(`${root}${sep}`)) {
        serveFile(request, response, index, false);
        return;
      }
      response.writeHead(404).end("not found");
    }
  });
}

export function startStaticServer({
  rootDirectory = process.argv[2] ?? ".",
  portValue = process.argv[3] ?? "4179",
  environment = process.env,
} = {}) {
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("invalid port");
  const server = createStaticServer({ rootDirectory, environment });
  server.listen(port, environment["HOST"] ?? "0.0.0.0", () => {
    process.stdout.write(`static server http://127.0.0.1:${port}\n`);
  });
  return server;
}

const isCommand = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCommand) startStaticServer();
