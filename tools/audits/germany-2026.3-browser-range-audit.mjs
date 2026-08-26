import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../..");
const RELEASE_ID = "infra-deutschland-2026.3";
const STATIC_RELEASE_ID = "karte-deutschland-2026.3-v2";
const AUDIT_SCHEMA = "zugfolge-germany-browser-range-audit/v2";
const DEFAULT_CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const VIEWPORT_PROBE = Object.freeze({ name: "Leipzig Hauptbahnhof", center: [12.3731, 51.3397], zoom: 13.4 });

const EXPECTED_ARTIFACTS = Object.freeze([
  {
    id: "basemap",
    sourceFile: "var/source-cache/annual-2026-pinned/welt-mit-deutschland-detail-2026-08-12-c766073e55b99b213276328e504cbb7a69b0b65db0546adf484539c3bd319aed.pmtiles",
    urlPath: `/artifacts/maps/${RELEASE_ID}/basemap.pmtiles`,
    bytes: 11_545_162_669,
    sha256: "c766073e55b99b213276328e504cbb7a69b0b65db0546adf484539c3bd319aed",
  },
  {
    id: "infrastructure",
    sourceFile: `var/derived/germany-2026.3/map-release-free-v2/${RELEASE_ID}.pmtiles`,
    urlPath: `/artifacts/maps/${RELEASE_ID}/${RELEASE_ID}.pmtiles`,
    bytes: 1_502_999_402,
    sha256: "83eaf2437b5ead10632228e92ccf84b6c1468f7f0317d0e1713571331a9d5ef5",
  },
]);

const EXPECTED_STYLE = Object.freeze({
  sourceFile: "var/derived/germany-2026.3/map-release-free-v2/style.json",
  urlPath: `/artifacts/maps/${RELEASE_ID}/style.json`,
  bytes: 268_406,
  sha256: "91e5a5530b4d678e34337151d8c0cb8e9a5568398634d16c17aa8184cf985854",
});

const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".pbf", "application/x-protobuf"],
  [".pmtiles", "application/vnd.pmtiles"],
  [".png", "image/png"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function within(parent, candidate) {
  const remainder = relative(parent, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function proveFile(root, descriptor) {
  const path = resolve(root, ...descriptor.sourceFile.split("/"));
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${descriptor.id ?? "style"} ist keine reguläre Datei.`);
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  invariant(within(canonicalRoot, canonicalPath), `${descriptor.id ?? "style"} verlässt die Repositorywurzel.`);
  const sha256 = await sha256File(canonicalPath);
  invariant(metadata.size === descriptor.bytes && sha256 === descriptor.sha256, `${descriptor.id ?? "style"} weicht vom Clean-v2-Bytevertrag ab.`);
  return { ...descriptor, path: canonicalPath, bytes: metadata.size, sha256 };
}

async function readRuntimeVersion(root, packageFile, expectedName) {
  const packageValue = JSON.parse(await readFile(resolve(root, ...packageFile.split("/")), "utf8"));
  invariant(
    packageValue.name === expectedName && typeof packageValue.version === "string" && packageValue.version.length > 0,
    `${expectedName}: ungültige lokale Paketidentität.`,
  );
  return packageValue.version;
}

function qaPage(runtimeVersions) {
  const releaseId = JSON.stringify(RELEASE_ID);
  const staticReleaseId = JSON.stringify(STATIC_RELEASE_ID);
  const runtime = JSON.stringify(runtimeVersions);
  const viewportProbe = JSON.stringify(VIEWPORT_PROBE);
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Zugfolge Deutschland 2026.3 Browser-Audit</title>
  <link rel="stylesheet" href="/vendor/maplibre/maplibre-gl.css">
  <style>html,body,#map{width:100%;height:100%;margin:0;background:#101215}#status{position:fixed;z-index:3;left:12px;top:12px;padding:8px;color:#fff;background:#101215dd;font:13px system-ui}</style>
</head>
<body data-complete="false"><div id="status">Clean-v2 wird geladen …</div><div id="map"></div>
<script type="importmap">{"imports":{"fflate":"/vendor/fflate/browser.js"}}</script>
<script type="module">
import * as maplibregl from "/vendor/maplibre/maplibre-gl.mjs";
import { Protocol } from "/vendor/pmtiles/index.js";
const releaseId=${releaseId};
const staticReleaseId=${staticReleaseId};
const runtimeVersions=${runtime};
const viewportProbe=${viewportProbe};
const errors=[];
const responses=[];
const originalConsoleError=console.error.bind(console);
console.error=(...args)=>{errors.push("console:"+args.map(String).join(" "));originalConsoleError(...args)};
addEventListener("error",event=>errors.push("page:"+(event.error?.message??event.message??"unknown")));
addEventListener("unhandledrejection",event=>errors.push("promise:"+(event.reason?.message??String(event.reason))));
const originalFetch=fetch.bind(window);
window.fetch=async (...args)=>{try{const response=await originalFetch(...args);responses.push({url:response.url,status:response.status});if(!response.ok)errors.push("http:"+response.status+":"+response.url);return response}catch(error){errors.push("network:"+(error?.message??String(error)));throw error}};
let completed=false;
async function complete(extra){
  if(completed)return;completed=true;
  const externalRequests=performance.getEntriesByType("resource").map(entry=>entry.name).filter(name=>/^https?:/u.test(name)&&!name.startsWith(location.origin+"/"));
  const result={releaseId,staticReleaseId,userAgent:navigator.userAgent,runtimeVersions,viewportProbe,errors,responses,externalRequests,...extra};
  globalThis.__zugfolgeAuditResult=result;
  document.body.dataset.complete="true";document.body.dataset.passed=String(result.passed===true);
  document.querySelector("#status").textContent=result.passed?"Clean-v2 Browser-Audit bestanden":"Clean-v2 Browser-Audit fehlgeschlagen";
}
setTimeout(()=>complete({passed:false,reason:"browser-timeout"}),30000);
try{
  const protocol=new Protocol();maplibregl.addProtocol("pmtiles",protocol.tile);
  const styleResponse=await fetch("/artifacts/maps/"+releaseId+"/style.json");
  if(!styleResponse.ok)throw new Error("style-http-"+styleResponse.status);
  const style=await styleResponse.json();
  const absolute=url=>new URL(url,location.href).href.replaceAll("%7B","{").replaceAll("%7D","}");
  if(typeof style.sprite==="string")style.sprite=absolute(style.sprite);
  if(typeof style.glyphs==="string")style.glyphs=absolute(style.glyphs);
  for(const source of Object.values(style.sources)){if(typeof source.url==="string")source.url=source.url.startsWith("pmtiles://")?"pmtiles://"+absolute(source.url.slice(10)):absolute(source.url)}
  const map=new maplibregl.Map({container:"map",style,center:viewportProbe.center,zoom:viewportProbe.zoom,hash:false,attributionControl:true});
  map.on("error",event=>errors.push("map:"+(event.error?.message??String(event.error))));
  map.once("load",()=>{
    map.addSource("qa-infrastructure",{type:"vector",url:"pmtiles://"+location.origin+"/artifacts/maps/"+releaseId+"/"+releaseId+".pmtiles"});
    map.addLayer({id:"qa-corridors",type:"line",source:"qa-infrastructure","source-layer":"rail_corridors",paint:{"line-color":"#31424b","line-width":4}});
    map.addLayer({id:"qa-tracks",type:"line",source:"qa-infrastructure","source-layer":"tracks",paint:{"line-color":"#63e6d4","line-width":2.2}});
    map.addLayer({id:"qa-platforms",type:"circle",source:"qa-infrastructure","source-layer":"platforms",paint:{"circle-color":"#ffd166","circle-radius":3}});
    map.once("idle",async()=>{
      const canvas=map.getCanvas();
      const gl=canvas.getContext("webgl2")??canvas.getContext("webgl");
      const counts={
        basemap:map.queryRenderedFeatures().filter(feature=>feature.source==="basemap").length,
        corridors:map.queryRenderedFeatures({layers:["qa-corridors"]}).length,
        tracks:map.queryRenderedFeatures({layers:["qa-tracks"]}).length,
        platforms:map.queryRenderedFeatures({layers:["qa-platforms"]}).length,
      };
      const state={mapLoaded:map.loaded(),tilesLoaded:map.areTilesLoaded(),basemapLoaded:map.isSourceLoaded("basemap"),infrastructureLoaded:map.isSourceLoaded("qa-infrastructure"),canvas:{width:canvas.width,height:canvas.height},webgl:gl===null?null:{version:gl.getParameter(gl.VERSION),renderer:gl.getParameter(gl.RENDERER)},counts};
      const passed=errors.length===0&&state.mapLoaded&&state.tilesLoaded&&state.basemapLoaded&&state.infrastructureLoaded&&state.canvas.width>0&&state.canvas.height>0&&state.webgl!==null&&counts.basemap>0&&(counts.corridors+counts.tracks+counts.platforms)>0;
      await complete({passed,state,reason:passed?null:"browser-assertion-failed"});
    });
  });
}catch(error){errors.push("setup:"+(error?.stack??error?.message??String(error)));await complete({passed:false,reason:"setup-failed"})}
</script></body></html>`;
}

function contentMapping(root, artifacts, style, runtimeVersions) {
  const fixed = new Map([
    ["/", { bytes: Buffer.from(qaPage(runtimeVersions), "utf8"), mime: "text/html; charset=utf-8" }],
    ["/index.html", { bytes: Buffer.from(qaPage(runtimeVersions), "utf8"), mime: "text/html; charset=utf-8" }],
    [style.urlPath, { path: style.path }],
    ...artifacts.map((artifact) => [artifact.urlPath, { path: artifact.path, pmtiles: true }]),
  ]);
  const prefixes = [
    ["/vendor/maplibre/", resolve(root, "apps/livemap/node_modules/maplibre-gl/dist")],
    ["/vendor/pmtiles/", resolve(root, "apps/livemap/node_modules/pmtiles/dist/esm")],
    ["/vendor/fflate/", resolve(root, "node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/esm")],
    [`/artifacts/maps/${RELEASE_ID}/assets/fonts/`, resolve(root, "var/source-cache/annual-2026-pinned/basemap-assets-2026-08-12/fonts")],
    [`/artifacts/maps/${RELEASE_ID}/assets/sprites/`, resolve(root, "var/source-cache/annual-2026-pinned/basemap-assets-2026-08-12/sprites")],
  ];
  return (pathname) => {
    if (fixed.has(pathname)) return fixed.get(pathname);
    for (const [prefix, directory] of prefixes) {
      if (!pathname.startsWith(prefix)) continue;
      const candidate = resolve(directory, ...pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent));
      if (within(directory, candidate) && candidate !== directory) return { path: candidate };
    }
    return undefined;
  };
}

async function startAuditServer(root, artifacts, style, runtimeVersions) {
  const requests = [];
  const mapping = contentMapping(root, artifacts, style, runtimeVersions);
  const server = createServer(async (request, response) => {
    request.on("error", () => {});
    response.on("error", () => {});
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const record = {
      method: request.method ?? "GET",
      path: pathname,
      range: request.headers.range ?? null,
      explicitProbe: request.headers["x-zugfolge-audit-probe"] === "explicit",
      status: 0,
      contentRange: null,
      bytes: 0,
    };
    const finish = (status, headers = {}, bytes = 0) => {
      record.status = status;
      record.contentRange = headers["Content-Range"] ?? headers["content-range"] ?? null;
      record.bytes = bytes;
      requests.push(record);
      response.writeHead(status, headers);
    };
    if (pathname === "/favicon.ico") {
      finish(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (!["GET", "HEAD"].includes(request.method ?? "")) {
      finish(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const target = mapping(pathname);
    if (target === undefined) {
      finish(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    try {
      if (target.bytes !== undefined) {
        finish(200, { "Content-Type": target.mime, "Content-Length": target.bytes.length, "Cache-Control": "no-store" }, target.bytes.length);
        if (request.method === "HEAD") response.end();
        else response.end(target.bytes);
        return;
      }
      const metadata = await lstat(target.path);
      invariant(metadata.isFile() && !metadata.isSymbolicLink(), "not-file");
      const baseHeaders = {
        "Content-Type": MIME.get(extname(target.path)) ?? "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      const match = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? "");
      if (match !== null) {
        const start = Number(match[1]);
        const end = match[2] === "" ? metadata.size - 1 : Number(match[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= metadata.size) {
          finish(416, { ...baseHeaders, "Content-Range": `bytes */${metadata.size}` });
          response.end();
          return;
        }
        const length = end - start + 1;
        finish(206, { ...baseHeaders, "Content-Range": `bytes ${start}-${end}/${metadata.size}`, "Content-Length": length }, length);
        if (request.method === "HEAD") response.end();
        else createReadStream(target.path, { start, end }).pipe(response);
        return;
      }
      if (target.pmtiles === true) {
        finish(428, { ...baseHeaders, "Content-Length": 0 });
        response.end();
        return;
      }
      finish(200, { ...baseHeaders, "Content-Length": metadata.size }, metadata.size);
      if (request.method === "HEAD") response.end();
      else createReadStream(target.path).pipe(response);
    } catch {
      finish(404, { "Cache-Control": "no-store" });
      response.end();
    }
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.on("connection", (socket) => socket.on("error", () => {}));
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  invariant(address !== null && typeof address === "object", "Auditserver besitzt keinen lokalen Port.");
  return { server, requests, origin: `http://127.0.0.1:${address.port}` };
}

async function probeRange(origin, artifact) {
  const requestedStart = 0;
  const requestedEnd = 126;
  const response = await fetch(`${origin}${artifact.urlPath}`, {
    headers: {
      Range: `bytes=${requestedStart}-${requestedEnd}`,
      "X-Zugfolge-Audit-Probe": "explicit",
    },
  });
  const body = Buffer.from(await response.arrayBuffer());
  const expectedContentRange = `bytes ${requestedStart}-${requestedEnd}/${artifact.bytes}`;
  assert.equal(response.status, 206, `${artifact.id}: Range-Status`);
  assert.equal(response.headers.get("accept-ranges"), "bytes", `${artifact.id}: Accept-Ranges`);
  assert.equal(response.headers.get("content-range"), expectedContentRange, `${artifact.id}: Content-Range`);
  assert.equal(body.length, requestedEnd - requestedStart + 1, `${artifact.id}: Range-Bytezahl`);
  assert.equal(body.subarray(0, 7).toString("ascii"), "PMTiles", `${artifact.id}: PMTiles-Magic`);
  assert.equal(body.readUInt8(7), 3, `${artifact.id}: PMTiles-Version`);
  return { status: response.status, acceptRanges: "bytes", contentRange: expectedContentRange, requestedStart, requestedEnd, bodyBytes: body.length, pmtilesVersion: 3 };
}

function requestRecord(request) {
  return {
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    fromServiceWorker: request.serviceWorker() !== null,
  };
}

function allowedHttpRequest(rawUrl, allowedOrigin) {
  try {
    const url = new URL(rawUrl);
    return ["http:", "https:"].includes(url.protocol) && url.origin === allowedOrigin;
  } catch {
    return false;
  }
}

function allowedWebSocket(rawUrl, allowedOrigin) {
  try {
    const url = new URL(rawUrl);
    const origin = new URL(allowedOrigin);
    const expectedProtocol = origin.protocol === "https:" ? "wss:" : "ws:";
    return url.protocol === expectedProtocol && url.hostname === origin.hostname && url.port === origin.port;
  } catch {
    return false;
  }
}

async function startOriginPolicyProxy(allowedOrigin) {
  const allowedRequests = [];
  const blockedRequests = [];
  const server = createServer((request, response) => {
    let target;
    try {
      target = new URL(request.url ?? "");
    } catch {
      blockedRequests.push({ kind: "http", method: request.method ?? "GET", url: request.url ?? "" });
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Zugfolge audit origin policy\n");
      return;
    }
    if (target.origin !== allowedOrigin || target.protocol !== "http:") {
      blockedRequests.push({ kind: "http", method: request.method ?? "GET", url: target.href });
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Zugfolge audit origin policy\n");
      return;
    }
    const record = { kind: "http", method: request.method ?? "GET", url: target.href, status: 0 };
    allowedRequests.push(record);
    const headers = { ...request.headers, host: target.host };
    delete headers["proxy-connection"];
    const upstream = httpRequest(target, { method: request.method, headers }, (upstreamResponse) => {
      record.status = upstreamResponse.statusCode ?? 0;
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.on("error", (error) => {
        record.transportError = error.code ?? error.message;
        if (!response.destroyed) response.destroy();
      });
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      record.status = 502;
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(`Zugfolge audit proxy upstream failure: ${error.message}\n`);
    });
    request.on("error", (error) => { record.clientError = error.code ?? error.message; });
    response.on("error", (error) => { record.responseError = error.code ?? error.message; });
    request.pipe(upstream);
  });
  server.on("connect", (request, socket) => {
    blockedRequests.push({ kind: "connect", method: "CONNECT", url: request.url ?? "" });
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  server.on("upgrade", (request, socket) => {
    blockedRequests.push({ kind: "websocket", method: request.method ?? "GET", url: request.url ?? "" });
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.on("connection", (socket) => socket.on("error", () => {}));
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  invariant(address !== null && typeof address === "object", "Origin-Policy-Proxy besitzt keinen lokalen Port.");
  return { server, allowedOrigin, allowedRequests, blockedRequests, origin: `http://127.0.0.1:${address.port}` };
}

function expectedBlockedChromeBackgroundRequest({ kind, url }) {
  if (kind === "http") {
    try {
      const target = new URL(url);
      return target.hostname === "clients2.google.com" && target.pathname === "/time/1/current";
    } catch {
      return false;
    }
  }
  return kind === "connect" && ["accounts.google.com:443", "www.google.com:443", "www.gstatic.com:443"].includes(url);
}

async function launchOriginLockedChrome(chromePath, allowedOrigin) {
  const gateway = await startOriginPolicyProxy(allowedOrigin);
  let browser;
  try {
    browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-extensions",
      `--proxy-server=${gateway.origin}`,
      "--proxy-bypass-list=127.0.0.1;localhost",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  } catch (error) {
    await new Promise((resolveClose) => gateway.server.close(resolveClose));
    throw error;
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  const network = {
    allowedOrigin,
    serviceWorkerPolicy: "blocked",
    allowedRequests: [],
    blockedRequests: [],
    failedRequests: [],
    blockedWebSockets: [],
    serviceWorkerRegistrations: [],
    webErrors: [],
  };
  context.on("requestfailed", (request) => network.failedRequests.push({
    ...requestRecord(request),
    errorText: request.failure()?.errorText ?? "unknown",
  }));
  context.on("serviceworker", (worker) => network.serviceWorkerRegistrations.push(worker.url()));
  context.on("weberror", (webError) => network.webErrors.push({
    message: webError.error().message,
    pageUrl: webError.page()?.url() ?? null,
  }));
  await context.route("**/*", async (route, request) => {
    const record = requestRecord(request);
    if (allowedHttpRequest(record.url, allowedOrigin)) {
      network.allowedRequests.push(record);
      await route.continue();
      return;
    }
    network.blockedRequests.push(record);
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/u, async (webSocket) => {
    if (allowedWebSocket(webSocket.url(), allowedOrigin)) {
      webSocket.connectToServer();
      return;
    }
    network.blockedWebSockets.push(webSocket.url());
    await webSocket.close({ code: 1008, reason: "Zugfolge audit origin policy" });
  });
  return { browser, context, network, gateway };
}

function networkIsolationProbePage() {
  return `<!doctype html><html><meta charset="utf-8"><title>Worker-Netzsperrenprobe</title><script>
const externalBase="http://zugfolge-worker-exfiltration.invalid";
function dedicatedWorkerProbe(){return new Promise((resolve,reject)=>{const source='fetch("'+externalBase+'/dedicated").then(()=>postMessage({blocked:false})).catch(error=>postMessage({blocked:true,error:String(error)}))';const worker=new Worker(URL.createObjectURL(new Blob([source],{type:"text/javascript"})));worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=event=>reject(new Error(event.message))})}
function sharedWorkerProbe(){return new Promise((resolve,reject)=>{const source='onconnect=event=>{const port=event.ports[0];fetch("'+externalBase+'/shared").then(()=>port.postMessage({blocked:false})).catch(error=>port.postMessage({blocked:true,error:String(error)}))}';const worker=new SharedWorker(URL.createObjectURL(new Blob([source],{type:"text/javascript"})));worker.port.onmessage=event=>{worker.port.close();resolve(event.data)};worker.onerror=event=>reject(new Error(event.message));worker.port.start()})}
async function serviceWorkerProbe(){try{const registration=await navigator.serviceWorker.register("/probe-service-worker.js");await new Promise(resolve=>setTimeout(resolve,100));return{registrationResolved:true,active:registration.active!==null,installing:registration.installing!==null,waiting:registration.waiting!==null,controlled:navigator.serviceWorker.controller!==null}}catch(error){return{registrationResolved:false,active:false,installing:false,waiting:false,controlled:false,error:String(error)}}}
globalThis.workerNetworkProbe=Promise.all([dedicatedWorkerProbe(),sharedWorkerProbe(),serviceWorkerProbe()]).then(([dedicated,shared,serviceWorker])=>({dedicated,shared,serviceWorker}));
</script></html>`;
}

async function startNetworkIsolationProbeServer() {
  const requests = [];
  const pageBytes = Buffer.from(networkIsolationProbePage(), "utf8");
  const serviceWorkerBytes = Buffer.from('fetch("https://zugfolge-worker-exfiltration.invalid/service");', "utf8");
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": pageBytes.length, "Cache-Control": "no-store" });
      response.end(pageBytes);
      return;
    }
    if (request.url === "/probe-service-worker.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": serviceWorkerBytes.length, "Cache-Control": "no-store", "Service-Worker-Allowed": "/" });
      response.end(serviceWorkerBytes);
      return;
    }
    if (request.url === "/favicon.ico") {
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(404, { "Cache-Control": "no-store" });
    response.end();
  });
  server.on("connection", (socket) => socket.on("error", () => {}));
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  invariant(address !== null && typeof address === "object", "Worker-Netzsperrenprobe besitzt keinen lokalen Port.");
  return { server, requests, origin: `http://127.0.0.1:${address.port}` };
}

export async function runBrowserNetworkIsolationNegativeProbe({
  chromePath = process.env.ZUGFOLGE_BROWSER_QA_CHROME ?? DEFAULT_CHROME,
  timeoutMs = 30_000,
} = {}) {
  const resolvedChrome = resolve(chromePath);
  const chromeMetadata = await lstat(resolvedChrome);
  invariant(chromeMetadata.isFile() && !chromeMetadata.isSymbolicLink(), "Chrome/Chromium ist keine reguläre lokale Programmdatei.");
  const probeServer = await startNetworkIsolationProbeServer();
  let browserControl;
  try {
    browserControl = await launchOriginLockedChrome(resolvedChrome, probeServer.origin);
    const page = await browserControl.context.newPage();
    const navigation = await page.goto(`${probeServer.origin}/`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    invariant(navigation?.ok() === true, "Worker-Netzsperrenprobe konnte die lokale Seite nicht laden.");
    const workerResults = await page.evaluate(async () => await globalThis.workerNetworkProbe);
    const externalBlocked = [
      ...browserControl.network.blockedRequests.map((request) => ({ ...request, enforcement: "playwright-browser-context" })),
      ...browserControl.gateway.blockedRequests.map((request) => ({ ...request, enforcement: "chrome-process-gateway" })),
    ].filter(({ url }) => url.startsWith("http://zugfolge-worker-exfiltration.invalid/"));
    assert.deepEqual(
      externalBlocked.map(({ url }) => new URL(url).pathname).sort(),
      ["/dedicated", "/shared"],
      "Origin-Allowlist erkannte nicht beide externen Worker-Fetches.",
    );
    invariant(workerResults.dedicated?.blocked === true, "Externer Dedicated-Worker-Fetch wurde nicht sicher gesperrt.");
    invariant(workerResults.shared?.blocked === true, "Externer Shared-Worker-Fetch wurde nicht sicher gesperrt.");
    invariant(
      workerResults.serviceWorker?.active === false
        && workerResults.serviceWorker?.installing === false
        && workerResults.serviceWorker?.waiting === false
        && workerResults.serviceWorker?.controlled === false,
      "Service Worker wurde trotz BrowserContext-Sperrvertrag aktiv.",
    );
    invariant(browserControl.context.serviceWorkers().length === 0, "Trotz Sperrvertrag wurde ein Service Worker gestartet.");
    invariant(browserControl.network.blockedWebSockets.length === 0, "Workerprobe öffnete unerwartet WebSockets.");
    return {
      schema: "zugfolge-browser-origin-policy-negative-proof/v1",
      allowedOrigin: probeServer.origin,
      blockedExternalRequests: externalBlocked,
      workerResults,
      serviceWorkerPolicy: browserControl.network.serviceWorkerPolicy,
      serviceWorkerRegistrations: browserControl.network.serviceWorkerRegistrations,
      passed: true,
    };
  } finally {
    await browserControl?.browser.close();
    if (browserControl !== undefined) await new Promise((resolveClose) => browserControl.gateway.server.close(resolveClose));
    await new Promise((resolveClose) => probeServer.server.close(resolveClose));
  }
}

export async function runGermany20263BrowserRangeAudit({
  repositoryRoot = REPOSITORY_ROOT,
  chromePath = process.env.ZUGFOLGE_BROWSER_QA_CHROME ?? DEFAULT_CHROME,
  timeoutMs = 90_000,
} = {}) {
  const root = resolve(repositoryRoot);
  const resolvedChrome = resolve(chromePath);
  const chromeMetadata = await lstat(resolvedChrome);
  invariant(chromeMetadata.isFile() && !chromeMetadata.isSymbolicLink(), "Chrome/Chromium ist keine reguläre lokale Programmdatei.");

  const artifacts = [];
  for (const descriptor of EXPECTED_ARTIFACTS) artifacts.push(await proveFile(root, descriptor));
  const style = await proveFile(root, { id: "style", ...EXPECTED_STYLE });
  const styleValue = JSON.parse(await readFile(style.path, "utf8"));
  invariant(
    styleValue.version === 8
      && styleValue.name === `Zugfolge Weltkarte dunkel ${RELEASE_ID}`
      && styleValue.metadata?.["zugfolge:release_id"] === RELEASE_ID
      && styleValue.sources?.basemap?.url === `pmtiles:///artifacts/maps/${RELEASE_ID}/basemap.pmtiles`,
    "Aktueller Style bindet nicht den erwarteten Clean-v2-Release.",
  );
  const runtimeVersions = {
    playwrightCore: await readRuntimeVersion(root, "apps/game-api/node_modules/playwright-core/package.json", "playwright-core"),
    mapLibreGl: await readRuntimeVersion(root, "apps/livemap/node_modules/maplibre-gl/package.json", "maplibre-gl"),
    pmtiles: await readRuntimeVersion(root, "apps/livemap/node_modules/pmtiles/package.json", "pmtiles"),
    fflate: await readRuntimeVersion(root, "node_modules/.pnpm/fflate@0.8.3/node_modules/fflate/package.json", "fflate"),
  };

  const auditServer = await startAuditServer(root, artifacts, style, runtimeVersions);
  let browserControl;
  try {
    const rangeProbes = [];
    for (const artifact of artifacts) rangeProbes.push({ id: artifact.id, ...(await probeRange(auditServer.origin, artifact)) });
    browserControl = await launchOriginLockedChrome(resolvedChrome, auditServer.origin);
    const page = await browserControl.context.newPage();
    const automationErrors = [];
    page.on("pageerror", (error) => automationErrors.push(`page:${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") automationErrors.push(`console:${message.text()}`);
    });
    const navigation = await page.goto(`${auditServer.origin}/`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    invariant(navigation?.ok() === true, `Headless Chrome erhielt für die Auditseite HTTP ${navigation?.status() ?? "keine Antwort"}.`);
    await page.waitForFunction(() => globalThis.__zugfolgeAuditResult !== undefined, undefined, { timeout: timeoutMs });
    const browserResult = await page.evaluate(() => globalThis.__zugfolgeAuditResult);
    invariant(browserResult?.passed === true, `Headless-Chrome-MapLibre-Lauf ist fehlgeschlagen: ${browserResult?.reason ?? "unbekannt"}.`);
    invariant(Array.isArray(browserResult.errors) && browserResult.errors.length === 0, `Browser meldet Seitenfehler: ${browserResult.errors?.join(" | ")}.`);
    invariant(Array.isArray(browserResult.externalRequests) && browserResult.externalRequests.length === 0, "Browser hat externe Karten- oder Assetadressen aufgerufen.");
    invariant(browserResult.releaseId === RELEASE_ID && browserResult.staticReleaseId === STATIC_RELEASE_ID, "Browser quittiert eine fremde Releaseidentität.");
    assert.deepEqual(browserResult.runtimeVersions, runtimeVersions, "Browser quittiert nicht die lokal ausgelieferten Laufzeitversionen.");
    assert.deepEqual(browserResult.viewportProbe, VIEWPORT_PROBE, "Browser quittiert nicht den Leipziger Prüfausschnitt.");
    invariant(/HeadlessChrome\/[0-9.]+/u.test(browserResult.userAgent), "QA wurde nicht in echtem Headless Chrome/Chromium ausgeführt.");
    invariant(browserResult.state?.mapLoaded === true && browserResult.state?.tilesLoaded === true, "MapLibre oder seine Tiles sind nicht vollständig geladen.");
    invariant(browserResult.state?.basemapLoaded === true && browserResult.state?.infrastructureLoaded === true, "Mindestens eine PMTiles-Quelle ist im Browser nicht geladen.");
    invariant(browserResult.state?.webgl !== null, "Headless Chrome besitzt keinen echten WebGL-Kartenkontext.");
    invariant(browserResult.state.counts?.basemap > 0, "Headless Chrome rendert keine Basemap-Features.");
    invariant(
      browserResult.state.counts.corridors + browserResult.state.counts.tracks + browserResult.state.counts.platforms > 0,
      "Headless Chrome rendert keine Infrastrukturfeatures.",
    );
    const browserVersion = await browserControl.browser.version();
    await browserControl.browser.close();
    browserControl.closed = true;
    invariant(automationErrors.length === 0, `Playwright meldet Seitenfehler: ${automationErrors.join(" | ")}.`);
    invariant(browserControl.network.blockedRequests.length === 0, `Browserweite Origin-Sperre blockierte externe Requests: ${browserControl.network.blockedRequests.map(({ url }) => url).join(", ")}.`);
    invariant(browserControl.network.failedRequests.length === 0, `Browser meldet fehlgeschlagene Requests: ${browserControl.network.failedRequests.map(({ url, errorText }) => `${url}:${errorText}`).join(", ")}.`);
    invariant(browserControl.network.blockedWebSockets.length === 0, "Browserweite Origin-Sperre blockierte externe WebSockets.");
    invariant(browserControl.network.serviceWorkerRegistrations.length === 0, "Auditseite startete unerwartet einen Service Worker.");
    invariant(browserControl.network.webErrors.length === 0, `BrowserContext meldet Webfehler: ${browserControl.network.webErrors.map(({ message }) => message).join(" | ")}.`);
    const unexpectedGatewayBlocks = browserControl.gateway.blockedRequests.filter((request) => !expectedBlockedChromeBackgroundRequest(request));
    invariant(unexpectedGatewayBlocks.length === 0, `Chrome-Prozess-Gateway blockierte unerwartete externe Requests: ${unexpectedGatewayBlocks.map(({ url }) => url).join(", ")}.`);
    invariant(browserControl.gateway.allowedRequests.every(({ status }) => status > 0 && status < 400), "Chrome-Prozess-Gateway beobachtete fehlerhafte lokale Antworten.");

    const failedRequests = auditServer.requests.filter(({ status }) => status >= 400);
    invariant(failedRequests.length === 0, `Lokaler Kartenserver meldet Netzwerkfehler: ${failedRequests.map(({ path, status }) => `${status}:${path}`).join(", ")}.`);
    const browserRangeRequests = Object.fromEntries(artifacts.map((artifact) => [
      artifact.id,
      auditServer.requests.filter(
        ({ path, status, explicitProbe }) => path === artifact.urlPath && status === 206 && !explicitProbe,
      ).length,
    ]));
    for (const artifact of artifacts) invariant(browserRangeRequests[artifact.id] > 0, `Headless Chrome hat ${artifact.id} nicht über HTTP-Range geladen.`);

    return {
      schema: AUDIT_SCHEMA,
      releaseId: RELEASE_ID,
      staticReleaseId: STATIC_RELEASE_ID,
      executedAt: new Date().toISOString(),
      viewportProbe: VIEWPORT_PROBE,
      artifacts: artifacts.map(({ path: ignoredPath, ...artifact }) => artifact),
      style: (({ path: ignoredPath, id: ignoredId, ...proof }) => proof)(style),
      rangeProbes,
      browser: {
        family: "chrome",
        mode: "headless-new",
        automation: "playwright-browser-context",
        executable: resolvedChrome,
        version: browserVersion,
        userAgent: browserResult.userAgent,
        runtimeVersions,
        state: browserResult.state,
        errors: browserResult.errors,
        externalRequests: browserResult.externalRequests,
        browserRangeRequests,
        networkPolicy: {
          allowedOrigin: browserControl.network.allowedOrigin,
          serviceWorkers: browserControl.network.serviceWorkerPolicy,
          allowedRequests: browserControl.network.allowedRequests.length,
          blockedRequests: browserControl.network.blockedRequests,
          failedRequests: browserControl.network.failedRequests,
          blockedWebSockets: browserControl.network.blockedWebSockets,
          serviceWorkerRegistrations: browserControl.network.serviceWorkerRegistrations,
          webErrors: browserControl.network.webErrors,
          processGateway: {
            allowedOrigin: browserControl.gateway.allowedOrigin,
            allowedRequests: browserControl.gateway.allowedRequests.length,
            blockedRequests: browserControl.gateway.blockedRequests,
            expectedBlockedChromeBackgroundRequests: browserControl.gateway.blockedRequests.length,
            unexpectedBlockedRequests: unexpectedGatewayBlocks,
          },
        },
      },
      http: {
        origin: auditServer.origin,
        requests: auditServer.requests.length,
        rangeRequests: auditServer.requests.filter(({ status }) => status === 206).length,
        failedRequests: 0,
      },
      passed: true,
    };
  } finally {
    if (browserControl !== undefined && browserControl.closed !== true) await browserControl.browser.close();
    if (browserControl !== undefined) await new Promise((resolveClose) => browserControl.gateway.server.close(resolveClose));
    await new Promise((resolveClose) => auditServer.server.close(resolveClose));
  }
}

export async function writeBrowserRangeAudit(audit, outputPath) {
  invariant(audit?.schema === AUDIT_SCHEMA && audit.passed === true, "Nur ein bestandener Browser-/Range-Beleg darf geschrieben werden.");
  const bytes = Buffer.from(`${JSON.stringify(audit, null, 2)}\n`, "utf8");
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  const handle = await open(output, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { outputPath: output, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const isCommand = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCommand) {
  const [outputPath] = process.argv.slice(2);
  const audit = await runGermany20263BrowserRangeAudit();
  const written = outputPath === undefined ? undefined : await writeBrowserRangeAudit(audit, outputPath);
  process.stdout.write(`${JSON.stringify({ ...audit, ...(written === undefined ? {} : { written }) })}\n`);
}
