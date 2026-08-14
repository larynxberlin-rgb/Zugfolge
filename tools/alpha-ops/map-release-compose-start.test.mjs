import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

function bashPath() {
  if (process.platform !== "win32") return "bash";
  return "C:\\Program Files\\Git\\bin\\bash.exe";
}

async function wrapperFixture(t, { environmentLines = [], pointerLines = [], releaseId = "infra-deutschland-2026.2" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-compose-pointer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "tools", "alpha-ops", "compose-with-map-release-env.sh");
  await mkdir(dirname(script), { recursive: true });
  await cp(new URL("./compose-with-map-release-env.sh", import.meta.url), script);
  await writeFile(join(directory, "compose.alpha.yml"), "name: zugfolge\nservices: {}\n", "utf8");
  await writeFile(join(directory, ".env"), [
    "MAP_RELEASE_DEPLOYMENT_HOST_ROOT=./maps",
    "POSTGRES_USER=zugfolge",
    ...environmentLines,
    "",
  ].join("\n"));
  await mkdir(join(directory, "maps", "active"), { recursive: true });
  await writeFile(join(directory, "maps", "active", "map-release.env"), [
    `MAP_RELEASE_ID=${releaseId}`,
    `MAP_RELEASE_HOST_DIR=releases/${releaseId}`,
    `MAP_BASEMAP_STYLE_URL=/artifacts/maps/${releaseId}/style.json`,
    `MAP_GERMANY_PMTILES_URL=/artifacts/maps/${releaseId}/${releaseId}.pmtiles`,
    ...pointerLines,
    "",
  ].join("\n"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const docker = join(bin, "docker");
  await writeFile(docker, [
    "#!/usr/bin/env bash",
    "printf 'ARG=%s\\n' \"$@\"",
    "printf 'SHELL_MAP_RELEASE_ID=%s\\n' \"${MAP_RELEASE_ID-unset}\"",
    "printf 'SHELL_MAP_RELEASE_HOST_DIR=%s\\n' \"${MAP_RELEASE_HOST_DIR-unset}\"",
    "printf 'START_PREFLIGHT_MODE=%s\\n' \"${MAP_RELEASE_START_PREFLIGHT_MODE-unset}\"",
  ].join("\n"));
  await chmod(docker, 0o755);
  return { directory, script, bin };
}

function runWrapper(fixture, args = ["-f", "compose.alpha.yml", "config"], extraEnvironment = {}) {
  return spawnSync(bashPath(), [fixture.script, ...args], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      MAP_RELEASE_ID: "forged-shell-release",
      MAP_RELEASE_HOST_DIR: "forged-shell-path",
      ...extraEnvironment,
    },
  });
}

test("host wrapper loads .env first and the sole active pointer last", async (t) => {
  const fixture = await wrapperFixture(t);
  const result = runWrapper(fixture);
  assert.equal(result.status, 0, result.stderr);
  const argumentsOnly = result.stdout.split("\n").filter((line) => line.startsWith("ARG=")).map((line) => line.slice(4));
  assert.deepEqual(argumentsOnly.slice(0, 8), [
    "compose",
    "--env-file", ".env",
    "--env-file", "./maps/active/map-release.env",
    "--project-name", "zugfolge",
    "--project-directory",
  ]);
  assert.match(argumentsOnly[8], /\/zugfolge-compose-pointer-[A-Za-z0-9_-]+$/u);
  assert.equal(argumentsOnly[9], "-f");
  assert.match(result.stdout, /^SHELL_MAP_RELEASE_ID=unset$/mu);
  assert.match(result.stdout, /^SHELL_MAP_RELEASE_HOST_DIR=unset$/mu);
  assert.match(result.stdout, /^START_PREFLIGHT_MODE=active-candidate$/mu);
});

test("rollback is explicit, ignores forged mode env, and requires container recreation", async (t) => {
  const fixture = await wrapperFixture(t, { releaseId: "infra-deutschland-2026.1" });
  const normal = runWrapper(fixture, ["-f", "compose.alpha.yml", "config"], { MAP_RELEASE_START_PREFLIGHT_MODE: "pre-activation" });
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /^START_PREFLIGHT_MODE=active-candidate$/mu);

  const unsafeRollback = runWrapper(fixture, ["--attested-rollback", "-f", "compose.alpha.yml", "up", "--no-build"]);
  assert.equal(unsafeRollback.status, 64);
  assert.match(unsafeRollback.stderr, /--force-recreate/);
  const restartRollback = runWrapper(fixture, ["--attested-rollback", "-f", "compose.alpha.yml", "restart", "game-api"]);
  assert.equal(restartRollback.status, 64);
  assert.match(restartRollback.stderr, /kein anderes Compose-Kommando/);

  const rollback = runWrapper(fixture, ["--attested-rollback", "-f", "compose.alpha.yml", "up", "--no-build", "--force-recreate"]);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(rollback.stdout, /^START_PREFLIGHT_MODE=pre-activation$/mu);
});

test("host wrapper rejects a second map source, malformed pointer, and caller env-file overrides", async (t) => {
  const duplicateSource = await wrapperFixture(t, { environmentLines: ["MAP_RELEASE_ID=infra-deutschland-2026.2"] });
  const duplicateResult = runWrapper(duplicateSource);
  assert.equal(duplicateResult.status, 65);
  assert.match(duplicateResult.stderr, /nur aus Pointer und explizitem Wrappermodus/);

  const foreignPointer = await wrapperFixture(t, { pointerLines: ["FOREIGN=value"] });
  const foreignResult = runWrapper(foreignPointer);
  assert.equal(foreignResult.status, 65);
  assert.match(foreignResult.stderr, /fremden Schluessel/);

  const override = await wrapperFixture(t);
  const overrideResult = runWrapper(override, ["-f", "compose.alpha.yml", "--env-file", "forged.env", "config"]);
  assert.equal(overrideResult.status, 64);
  assert.match(overrideResult.stderr, /nicht erlaubt/);
  const projectOverride = runWrapper(override, ["-p", "shadow-stack", "-f", "compose.alpha.yml", "config"]);
  assert.equal(projectOverride.status, 64);
  assert.match(projectOverride.stderr, /fest auf zugfolge gebunden/);
  const composeOverride = runWrapper(override, ["-f", "foreign.yml", "config"]);
  assert.equal(composeOverride.status, 64);
  assert.match(composeOverride.stderr, /nur die Repo-Vorlage compose\.alpha\.yml/);
  const argumentOverride = runWrapper(override, ["-f", "compose.alpha.yml", "run", "-e", "MAP_RELEASE_ID=forged", "game-api"]);
  assert.equal(argumentOverride.status, 64);
  assert.match(argumentOverride.stderr, /duerfen nicht als Compose-Argument ueberschrieben werden/);
  const envMode = await wrapperFixture(t, { environmentLines: ["MAP_RELEASE_START_PREFLIGHT_MODE=pre-activation"] });
  const envModeResult = runWrapper(envMode);
  assert.equal(envModeResult.status, 65);
  assert.match(envModeResult.stderr, /explizitem Wrappermodus/);

  const unterminated = await wrapperFixture(t);
  const unterminatedPath = join(unterminated.directory, "maps", "active", "map-release.env");
  const unterminatedBytes = await readFile(unterminatedPath);
  await writeFile(unterminatedPath, unterminatedBytes.subarray(0, -1));
  const unterminatedResult = runWrapper(unterminated);
  assert.equal(unterminatedResult.status, 65);
  assert.match(unterminatedResult.stderr, /mit genau einer LF-Zeile enden/);
});

test("fixed stop reaches only the canonical zugfolge project without a usable map pointer", async (t) => {
  const fixture = await wrapperFixture(t);
  await rm(join(fixture.directory, "maps", "active", "map-release.env"));

  const stopped = runWrapper(fixture, ["--fixed-stop", "-f", "compose.alpha.yml", "down"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const argumentsOnly = stopped.stdout.split("\n").filter((line) => line.startsWith("ARG=")).map((line) => line.slice(4));
  assert.deepEqual(argumentsOnly.slice(0, 4), ["compose", "--env-file", ".env", "--project-name"]);
  assert.equal(argumentsOnly[4], "zugfolge");
  assert.match(stopped.stdout, /^SHELL_MAP_RELEASE_ID=infra-stop-placeholder-2000\.1$/mu);

  await writeFile(join(fixture.directory, "maps", "active", "map-release.env"), "BROKEN POINTER\n", "utf8");
  const corruptPointerStop = runWrapper(fixture, ["--fixed-stop", "-f", "compose.alpha.yml", "down"]);
  assert.equal(corruptPointerStop.status, 0, corruptPointerStop.stderr);
  assert.match(corruptPointerStop.stdout, /ARG=zugfolge/u);

  const unsafeAction = runWrapper(fixture, ["--fixed-stop", "-f", "compose.alpha.yml", "up"]);
  assert.equal(unsafeAction.status, 64);
  assert.match(unsafeAction.stderr, /ausschliesslich .* down/);
});

test("installed compose.yml must remain byte-identical to the repository template", async (t) => {
  const fixture = await wrapperFixture(t);
  const template = join(fixture.directory, "compose.alpha.yml");
  const installed = join(fixture.directory, "compose.yml");
  await cp(template, installed);

  const accepted = runWrapper(fixture, ["-f", "compose.yml", "config"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  await writeFile(installed, "name: shadow-stack\nservices: {}\n", "utf8");
  const drift = runWrapper(fixture, ["-f", "compose.yml", "config"]);
  assert.equal(drift.status, 65);
  assert.match(drift.stderr, /nicht bytegleich mit der Repo-Vorlage/);
});

test("Compose restarts Game API and Livemap only through the explicit per-process map gate", async () => {
  const [compose, environment, phase1, build, phase3, service, rollbackService, installation] = await Promise.all([
    read("compose.alpha.yml"),
    read(".env.example"),
    read("tools/alpha-ops/phase1-smoke.sh"),
    read("tools/alpha-ops/build-alpha-images.sh"),
    read("tools/alpha-ops/phase3-acceptance.sh"),
    read("ops/alpha/zugfolge-alpha.service"),
    read("ops/alpha/zugfolge-alpha-rollback.service"),
    read("ALPHA-INSTALL.md"),
  ]);
  assert.match(compose, /^name: zugfolge$/mu);
  const odooUpgrade = compose.slice(compose.indexOf("  odoo-upgrade:"), compose.indexOf("  keycloak:"));
  const odoo = compose.slice(compose.indexOf("  odoo:"), compose.indexOf("  alpha-ops:"));
  assert.match(odooUpgrade, /image: zugfolge-odoo:alpha/u);
  assert.match(odoo, /image: zugfolge-odoo:alpha/u);
  const gameApi = compose.slice(compose.indexOf("  game-api:"), compose.indexOf("  game-web:"));
  const livemap = compose.slice(compose.indexOf("  livemap:"), compose.indexOf("  operations-center:"));
  for (const serviceSource of [gameApi, livemap]) {
    assert.match(serviceSource, /command: \[node, tools\/alpha-ops\/start-after-map-release-preflight\.mjs, node,/u);
    assert.match(serviceSource, /MAP_RELEASE_PREFLIGHT_EXPECTED_ACTIVE_RELEASE_ID:/u);
    assert.match(serviceSource, /MAP_RELEASE_START_PREFLIGHT_MODE:/u);
    assert.match(serviceSource, /:\/map-deployment:ro/u);
    assert.match(serviceSource, /:\/map-preflight:ro/u);
    assert.match(serviceSource, /:\/map-restore:ro/u);
  }
  assert.doesNotMatch(environment, /^MAP_RELEASE_ID=/mu);
  assert.doesNotMatch(environment, /^MAP_RELEASE_HOST_DIR=/mu);
  assert.doesNotMatch(environment, /^MAP_BASEMAP_STYLE_URL=/mu);
  assert.doesNotMatch(environment, /^MAP_GERMANY_PMTILES_URL=/mu);
  assert.match(environment, /^MAP_RELEASE_DEPLOYMENT_HOST_ROOT=\.\/var\/maps$/mu);
  for (const script of [phase1, build, phase3]) assert.match(script, /compose-with-map-release-env\.sh/u);
  assert.doesNotMatch([phase1, build, phase3].join("\n"), /docker compose/u);
  assert.match(service, /ExecStart=.*compose-with-map-release-env\.sh/u);
  assert.match(service, /ExecStop=.*compose-with-map-release-env\.sh --fixed-stop -f \/opt\/zugfolge\/compose\.yml down/u);
  assert.doesNotMatch(service, /ExecStart=.*docker compose/u);
  assert.match(service, /Conflicts=zugfolge-alpha-rollback\.service/u);
  assert.match(rollbackService, /Conflicts=zugfolge-alpha\.service/u);
  assert.match(rollbackService, /ExecStart=.*compose-with-map-release-env\.sh --attested-rollback[\s\S]*up --no-build --force-recreate/u);
  assert.match(rollbackService, /ExecStop=.*compose-with-map-release-env\.sh --fixed-stop -f \/opt\/zugfolge\/compose\.yml down/u);
  const oneShot = compose.slice(compose.indexOf("  map-release-preflight:"), compose.indexOf("  game-migrate:"));
  assert.match(oneShot, /map-release-deployment-preflight\.mjs, "\$\{MAP_RELEASE_START_PREFLIGHT_MODE:\?[^}]+\}"/u);
  assert.doesNotMatch(installation, /^docker compose .*\b(?:up|run|restart|down)\b/mu);
  assert.match(installation, /docker compose --env-file \/opt\/zugfolge\/\.env[\s\\]+\s+--env-file \/opt\/zugfolge\/maps\/active\/map-release\.env/u);
});
