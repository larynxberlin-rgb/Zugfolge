import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStaticServer, runtimeConfiguration } from "./static-server.mjs";
import { LIVEMAP_READ_MODEL_USER_VERSION } from "../tiles/livemap-read-model.mjs";

const releaseId = "infra-deutschland-2026.2";
const publicBasePath = `/artifacts/maps/${releaseId}`;

test("fehlender SPA-Einstieg und ungueltige Request-URL beenden den Server nicht", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-empty-static-"));
  const server = createStaticServer({ rootDirectory: directory, environment: {} });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/unbekannte-route`)).status, 404);
  const invalidStatus = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: server.address().port, path: "http://[" }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
  assert.equal(invalidStatus, 400);
  assert.equal((await fetch(`${origin}/runtime-config.js`)).status, 200);
});

test("API-Proxy beendet abgebrochene Streams auf beiden Seiten", { timeout: 5_000 }, async (t) => {
  let finishUpstream;
  const upstreamClosed = new Promise((resolve) => { finishUpstream = resolve; });
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("angefangen");
    if (request.url === "/upstream-abort") setImmediate(() => response.destroy());
    else response.once("close", finishUpstream);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createStaticServer({ environment: { GAME_API_INTERNAL_URL: `http://127.0.0.1:${upstream.address().port}` } });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    for (const server of [proxy, upstream]) server.closeAllConnections();
    await Promise.all([proxy, upstream].map((server) => new Promise((resolve) => server.close(resolve))));
  });
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  await assert.rejects(async () => (await fetch(`${origin}/api/upstream-abort`)).text());
  await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/client-abort`, (response) => {
      response.once("data", () => { request.destroy(); resolve(); });
    });
    request.once("error", reject);
    request.end();
  });
  await upstreamClosed;
  assert.equal((await fetch(`${origin}/runtime-config.js`)).status, 200);
});

test("API-Proxy bewahrt kanonischen und fremden Host fuer die autoritative Hostgrenze", async (t) => {
  const upstream = createServer((request, response) => {
    response.writeHead(request.headers.host === "world.zugfolge.de" ? 200 : 421, { "content-type": "application/json" });
    response.end(JSON.stringify({ host: request.headers.host, url: request.url }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createStaticServer({ rootDirectory: ".", environment: { GAME_API_INTERNAL_URL: `http://127.0.0.1:${upstream.address().port}` } });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });
  async function read(host) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${proxy.address().port}/api/worlds?status=active`, {
        headers: { host, "x-forwarded-host": "world.zugfolge.de" },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      });
      request.on("error", reject); request.end();
    });
  }
  assert.deepEqual(await read("world.zugfolge.de"), { status: 200, body: { host: "world.zugfolge.de", url: "/worlds?status=active" } });
  assert.deepEqual(await read("other.zugfolge.de"), { status: 421, body: { host: "other.zugfolge.de", url: "/worlds?status=active" } });
});

function parseEnvironmentExample(source) {
  return Object.fromEntries(source
    .split(/\r?\n/u)
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      assert.notEqual(separator, -1, `ungueltige Beispielvariable: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

test("API-Pfade mit doppeltem Slash koennen keinen fremden Upstream oder Headerempfaenger waehlen", async (t) => {
  let foreignRequests = 0;
  const foreign = createServer((_request, response) => { foreignRequests += 1; response.end("foreign"); });
  const upstream = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ url: request.url, authorization: request.headers.authorization }));
  });
  foreign.listen(0, "127.0.0.1");
  upstream.listen(0, "127.0.0.1");
  await Promise.all([once(foreign, "listening"), once(upstream, "listening")]);
  const proxy = createStaticServer({ rootDirectory: ".", environment: { GAME_API_INTERNAL_URL: `http://127.0.0.1:${upstream.address().port}` } });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    await Promise.all([proxy, upstream, foreign].map((server) => new Promise((resolve) => server.close(resolve))));
  });
  const path = `//127.0.0.1:${foreign.address().port}/worlds?world=foreign`;
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/api${path}`, { headers: { authorization: "Bearer proxy-regression" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: path, authorization: "Bearer proxy-regression" });
  assert.equal(foreignRequests, 0);
});

test("Paketplan, ReadModel v3, Alpha-Compose und Runtime-Konfiguration verwenden dieselbe Releasewurzel", async () => {
  const [planSource, readModelSpecSource, compose, environmentSource] = await Promise.all([
    readFile(new URL("../tiles/map-package.annual-2026.2.plan.json", import.meta.url), "utf8"),
    readFile(new URL("../tiles/livemap-read-model.annual-2026.2.json", import.meta.url), "utf8"),
    readFile(new URL("../../compose.alpha.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.env.example", import.meta.url), "utf8"),
  ]);
  const plan = JSON.parse(planSource);
  const readModelSpec = JSON.parse(readModelSpecSource);
  const environment = parseEnvironmentExample(environmentSource);
  const readModel = plan.auxiliaryFiles.find((file) => file.kind === "read-model");

  assert.equal(plan.version, "2026.2");
  assert.equal(plan.runtime.publicBasePath, publicBasePath);
  assert.equal(readModelSpec.infrastructureReleaseId, releaseId);
  assert.equal(readModelSpec.config.infrastructureReleaseId, releaseId);
  assert.equal(LIVEMAP_READ_MODEL_USER_VERSION, 3);
  assert.equal(environment.MAP_RELEASE_ID, undefined);
  assert.equal(environment.MAP_RELEASE_DEPLOYMENT_HOST_ROOT, "./var/maps");
  assert.equal(environment.MAP_RELEASE_HOST_DIR, undefined);
  assert.equal(environment.MAP_BASEMAP_STYLE_URL, undefined);
  assert.equal(environment.MAP_GERMANY_PMTILES_URL, undefined);
  assert.equal(readModel?.installPath, "read-model.sqlite");

  const defaults = runtimeConfiguration({});
  assert.equal(defaults.livemapOidcClientId, "livemap");
  assert.equal(runtimeConfiguration({ LIVEMAP_OIDC_CLIENT_ID: "game-web" }).livemapOidcClientId, "game-web");
  assert.equal(defaults.mapBasemapStyleUrl, plan.runtime.basemapStyleUrl);
  assert.equal(defaults.mapGermanyPmtilesUrl, plan.runtime.infrastructurePmtilesUrl);
  assert.throws(
    () => runtimeConfiguration({ MAP_RELEASE_ID: releaseId, MAP_BASEMAP_STYLE_URL: "/artifacts/maps/anderes/style.json" }),
    /nicht dasselbe installierte Release/u,
  );

  assert.match(compose, /LIVEMAP_READ_MODEL_PATH: \/map-release\/read-model\.sqlite/u);
  const livemapService = compose.slice(compose.indexOf("  livemap:"), compose.indexOf("  operations-center:"));
  const gameWebService = compose.slice(compose.indexOf("  game-web:"), compose.indexOf("  livemap:"));
  assert.match(livemapService, /LIVEMAP_OIDC_CLIENT_ID: "\$\{LIVEMAP_OIDC_CLIENT_ID:-livemap\}"/u);
  assert.doesNotMatch(gameWebService, /LIVEMAP_OIDC_CLIENT_ID/u);
  assert.match(
    compose,
    /\$\{MAP_RELEASE_DEPLOYMENT_HOST_ROOT:\?[^}]+\}\/\$\{MAP_RELEASE_HOST_DIR:\?[^}]+\}:\/map-release:ro/u,
  );
  assert.match(
    compose,
    /\$\{MAP_RELEASE_DEPLOYMENT_HOST_ROOT:\?[^}]+\}\/\$\{MAP_RELEASE_HOST_DIR:\?[^}]+\}:\/map-artifacts\/maps\/\$\{MAP_RELEASE_ID:\?[^}]+\}:ro/u,
  );
  assert.match(compose, /STATIC_ARTIFACT_ROOT: \/map-artifacts/u);
  assert.match(compose, /MAP_RELEASE_ID: "\$\{MAP_RELEASE_ID:\?[^}]+\}"/u);
  assert.match(compose, /MAP_BASEMAP_STYLE_URL: "\$\{MAP_BASEMAP_STYLE_URL:\?[^}]+\}"/u);
  assert.match(compose, /MAP_GERMANY_PMTILES_URL: "\$\{MAP_GERMANY_PMTILES_URL:\?[^}]+\}"/u);
  assert.doesNotMatch(compose, /infra-deutschland-2026\.1/u);
  assert.doesNotMatch(environmentSource, /infra-deutschland-2026\.1/u);
});

test("statischer Server liefert das versionierte Kartenpaket mit Byte-Ranges aus", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-static-map-"));
  const webRoot = join(directory, "web");
  const artifactRoot = join(directory, "artifacts");
  const releaseRoot = join(artifactRoot, "maps", releaseId);
  await mkdir(webRoot, { recursive: true });
  await mkdir(releaseRoot, { recursive: true });
  await writeFile(join(webRoot, "index.html"), "livemap", "utf8");
  await writeFile(join(webRoot, "maplibre-gl-worker.mjs"), "export default {};", "utf8");
  await writeFile(join(releaseRoot, "style.json"), "{\"version\":8}", "utf8");
  await writeFile(join(releaseRoot, "basemap.pmtiles"), Buffer.from([80, 77, 84, 105, 108, 101, 115]));
  await writeFile(join(releaseRoot, `${releaseId}.pmtiles`), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  await writeFile(join(releaseRoot, "read-model.sqlite"), Buffer.from("SQLite format 3\u0000", "binary"));

  const server = createStaticServer({
    rootDirectory: webRoot,
    artifactRootDirectory: artifactRoot,
    environment: {
      GAME_API_INTERNAL_URL: "http://game-api:3000",
      LIVEMAP_OIDC_CLIENT_ID: "game-web",
      MAP_RELEASE_ID: releaseId,
      MAP_BASEMAP_STYLE_URL: `${publicBasePath}/style.json`,
      MAP_GERMANY_PMTILES_URL: `${publicBasePath}/${releaseId}.pmtiles`,
    },
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const configResponse = await fetch(`${origin}/runtime-config.js`);
    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.headers.get("cache-control"), "no-store");
    const configScript = await configResponse.text();
    const config = JSON.parse(configScript
      .replace("globalThis.__ZUGFOLGE_RUNTIME_CONFIG__=", "")
      .replace(/;\s*$/u, ""));
    assert.equal(config.mapBasemapStyleUrl, `${publicBasePath}/style.json`);
    assert.equal(config.mapGermanyPmtilesUrl, `${publicBasePath}/${releaseId}.pmtiles`);
    assert.equal(config.livemapOidcClientId, "game-web");

    const rangeResponse = await fetch(`${origin}${publicBasePath}/${releaseId}.pmtiles`, {
      headers: { range: "bytes=1-3" },
    });
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get("accept-ranges"), "bytes");
    assert.equal(rangeResponse.headers.get("content-range"), "bytes 1-3/8");
    assert.equal(rangeResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(new Uint8Array(await rangeResponse.arrayBuffer()), new Uint8Array([1, 2, 3]));

    const [styleResponse, basemapResponse, readModelResponse, workerResponse] = await Promise.all([
      fetch(`${origin}${publicBasePath}/style.json`),
      fetch(`${origin}${publicBasePath}/basemap.pmtiles`),
      fetch(`${origin}${publicBasePath}/read-model.sqlite`, { method: "HEAD" }),
      fetch(`${origin}/maplibre-gl-worker.mjs`),
    ]);
    assert.equal(styleResponse.status, 200);
    assert.equal(basemapResponse.status, 200);
    assert.equal(readModelResponse.status, 200);
    assert.equal(readModelResponse.headers.get("content-type"), "application/vnd.sqlite3");
    assert.equal(readModelResponse.headers.get("content-length"), "16");
    assert.equal(workerResponse.status, 200);
    assert.equal(workerResponse.headers.get("content-type"), "text/javascript; charset=utf-8");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await rm(directory, { recursive: true, force: true });
  }
});
