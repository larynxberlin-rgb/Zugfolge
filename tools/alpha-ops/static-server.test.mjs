import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStaticServer, runtimeConfiguration } from "./static-server.mjs";

const releaseId = "infra-deutschland-2026.1";
const publicBasePath = `/artifacts/maps/${releaseId}`;

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

test("Paketplan, Alpha-Compose und Runtime-Konfiguration verwenden dieselbe Releasewurzel", async () => {
  const [planSource, compose, environmentSource, dockerfile] = await Promise.all([
    readFile(new URL("../tiles/map-package.annual-2026.plan.json", import.meta.url), "utf8"),
    readFile(new URL("../../compose.alpha.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../../ops/alpha/container/Dockerfile", import.meta.url), "utf8"),
  ]);
  const plan = JSON.parse(planSource);
  const environment = parseEnvironmentExample(environmentSource);
  const readModel = plan.auxiliaryFiles.find((file) => file.kind === "read-model");

  assert.equal(plan.runtime.publicBasePath, publicBasePath);
  assert.equal(environment.MAP_RELEASE_ID, releaseId);
  assert.equal(environment.MAP_RELEASE_HOST_DIR, `./var/maps/releases/${releaseId}`);
  assert.equal(environment.MAP_BASEMAP_STYLE_URL, plan.runtime.basemapStyleUrl);
  assert.equal(environment.MAP_GERMANY_PMTILES_URL, plan.runtime.infrastructurePmtilesUrl);
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
  assert.match(
    compose,
    /\$\{MAP_RELEASE_HOST_DIR:-\.\/var\/maps\/releases\/infra-deutschland-2026\.1\}:\/map-release:ro/u,
  );
  assert.match(
    compose,
    /\$\{MAP_RELEASE_HOST_DIR:-\.\/var\/maps\/releases\/infra-deutschland-2026\.1\}:\/map-artifacts\/maps\/\$\{MAP_RELEASE_ID:-infra-deutschland-2026\.1\}:ro/u,
  );
  assert.match(compose, /STATIC_ARTIFACT_ROOT: \/map-artifacts/u);
  assert.ok(compose.includes(`MAP_RELEASE_ID: "\${MAP_RELEASE_ID:-${releaseId}}"`));
  assert.ok(compose.includes(`MAP_BASEMAP_STYLE_URL: "\${MAP_BASEMAP_STYLE_URL:-${plan.runtime.basemapStyleUrl}}"`));
  assert.ok(compose.includes(`MAP_GERMANY_PMTILES_URL: "\${MAP_GERMANY_PMTILES_URL:-${plan.runtime.infrastructurePmtilesUrl}}"`));
  assert.match(compose, /game-migrate:[\s\S]*packages\/db\/dist\/migrate\.js/u);
  assert.match(compose, /game-bootstrap:[\s\S]*production-db-bootstrap\.mjs/u);
  assert.match(compose, /game-bootstrap: \{ condition: service_completed_successfully \}/u);
  assert.deepEqual(JSON.parse(environment.ALPHA_WORLD_RELEASE_PATHS_JSON), [
    "/evidence/alpha-world-deployment.json.signed.json",
  ]);
  assert.equal(environment.LIVEMAP_OIDC_CLIENT_ID, "livemap");
  assert.equal(environment.LIVEMAP_BASE_PATH, "/");
  assert.equal(environment.OPERATIONS_CENTER_BASE_PATH, "/");
  for (const buildArgument of [
    "LIVEMAP_BASE_PATH",
    "OPERATIONS_CENTER_BASE_PATH",
    "OPERATIONS_CENTER_GAME_API_URL",
  ]) {
    assert.ok(dockerfile.includes(`ARG ${buildArgument}=`));
    assert.ok(compose.includes(`${buildArgument}: "\${${buildArgument}:-`));
  }
  assert.match(
    compose,
    /operations-center:[\s\S]*GAME_API_INTERNAL_URL: http:\/\/game-api:3000/u,
  );
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
