import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const text = (path) => readFile(resolve(root, path), "utf8");

test("2026.5 besitzt einen eigenen manuell geschlossenen Builder- und Runtime-Dispatch", async () => {
  const workflow = await text(".github/workflows/ci.yml");
  const builderStart = workflow.indexOf("\n  germany-2026-5-real-builder-reproduction:");
  const runtimeStart = workflow.indexOf("\n  germany-2026-5-real-acceptance:", builderStart);
  const integrationStart = workflow.indexOf("\n  integration-api:", runtimeStart);
  assert.ok(builderStart > 0 && runtimeStart > builderStart && integrationStart > runtimeStart);
  const builder = workflow.slice(builderStart, runtimeStart);
  const runtime = workflow.slice(runtimeStart, integrationStart);

  assert.match(workflow, /run_germany_2026_5_real_acceptance:[\s\S]{0,240}default: false[\s\S]{0,80}type: boolean/u);
  for (const job of [builder, runtime]) {
    assert.match(job, /github\.event_name == 'workflow_dispatch'[\s\S]*inputs\.run_germany_2026_5_real_acceptance == true/u);
    assert.doesNotMatch(job, /2026\.4|transfer-demands-v1/u);
    assert.doesNotMatch(job, /PENDING|PLACEHOLDER|DUMMY/u);
  }
  assert.match(builder, /runs-on: \[self-hosted, windows, x64, germany-2026-5-builder\]/u);
  assert.match(runtime, /runs-on: \[self-hosted, linux, x64, germany-2026-5-runtime\]/u);
  assert.match(builder, /ZUGFOLGE_REAL_GERMANY_2026_5_WINDOWS_ROOT/u);
  assert.match(runtime, /ZUGFOLGE_REAL_GERMANY_2026_5_ROOT/u);
  assert.match(runtime, /needs: germany-2026-5-real-builder-reproduction/u);
  for (const job of [builder, runtime]) {
    assert.match(job, /fetch-depth: 0/u);
    assert.match(job, /git worktree add --detach/u);
    assert.match(job, /git merge-base --is-ancestor/u);
    assert.match(job, /ZUGFOLGE_REAL_GERMANY_2026_5_SOURCE_ROOT/u);
    assert.match(job, /ZUGFOLGE_REAL_GERMANY_PIN_REGISTRATION_COMMIT/u);
  }
});

test("2026.5 reproduziert PMTiles, Capture und Static Sources create-new mit aktuellen Vertragen", async () => {
  const workflow = await text(".github/workflows/ci.yml");
  const builder = workflow.slice(
    workflow.indexOf("\n  germany-2026-5-real-builder-reproduction:"),
    workflow.indexOf("\n  germany-2026-5-real-acceptance:"),
  );
  assert.match(builder, /\$pmtiles = Join-Path \$builderArtifactRoot "map-release-free-v2\/infra-deutschland-2026\.5\.pmtiles"/u);
  assert.match(builder, /build-gdal-semantic-pmtiles\.mjs[\s\S]*semantic-tile-inputs-free-v2\/inputs\.json[\s\S]*\$pmtiles[\s\S]*gdal-runtime\.3\.13\.2-win32-x64\.manifest\.json[\s\S]*"\."/u);
  assert.match(builder, /tools\/gdal-runtime-3\.13\.2-win32-x64\/manifest\.json/u);
  assert.doesNotMatch(builder, /var\/tooling-pinned\/gdal|ogr2ogr\.exe|\bPATH\b/u);
  assert.match(builder, /build-map-source-capture\.mjs[\s\S]*map-asset-notices\.annual-2026\.5\.json/u);
  assert.match(builder, /static-map-sources-cli\.mjs[\s\S]*materialize[\s\S]*map-asset-notices\.annual-2026\.5\.json/u);
  assert.equal((builder.match(/map-asset-notices\.annual-2026\.5\.json/gu) ?? []).length, 2);
  assert.match(builder, /verify-builder[\s\S]*BUILDER_ARTIFACT_ROOT/u);
  assert.match(builder, /verify-builder[\s\S]*WINDOWS_CANDIDATE_ROOT[\s\S]*PIN_REGISTRATION_COMMIT/u);
  assert.match(builder, /Create-new Builderziel existiert bereits/u);
});

test("2026.5 trennt Harness-Builder, Validator, Runtime-RSS und Worker-PostgreSQL hart", async () => {
  const workflow = await text(".github/workflows/ci.yml");
  const runtime = workflow.slice(
    workflow.indexOf("\n  germany-2026-5-real-acceptance:"),
    workflow.indexOf("\n  integration-api:"),
  );
  assert.match(runtime, /harness-builder[\s\S]*MemoryMax=8589934592[\s\S]*MemorySwapMax=0/u);
  assert.match(runtime, /2026-5-validator[\s\S]*MemoryMax=1073741824[\s\S]*MemorySwapMax=0/u);
  assert.match(runtime, /docker run --rm --network none[\s\S]*--memory 512m --memory-swap 512m[\s\S]*memory\.peak/u);
  assert.match(runtime, /2026-5-worker[\s\S]*MemoryMax=536870912[\s\S]*MemorySwapMax=0/u);
  assert.match(runtime, /POSTGRES_DB: zugfolge_germany_e2e_2026_5_ci/u);
  assert.match(runtime, /- 5432\/tcp/u);
  assert.match(runtime, /external-postgresql-process-outside-measured-app-cgroup/u);
  assert.match(runtime, /timetable-routes-v2\.transfer-demands-v2\.json/u);
  assert.match(runtime, /alpha-world-deployment\.2026\.5\.json[\s\S]*alpha-world-deployment\.2026\.5\.signed\.json/u);
  assert.match(runtime, /write-rss-proof[\s\S]*ZUGFOLGE_REAL_GERMANY_EXPECTED_SOURCE_COMMIT/u);
  assert.match(runtime, /write-rss-proof[\s\S]*ZUGFOLGE_REAL_GERMANY_PIN_REGISTRATION_COMMIT/u);
  assert.match(runtime, /germany-2026\.5-signed-game-staging\.real\.test\.mjs/u);
  assert.match(runtime, /ZUGFOLGE_REAL_SIGNED_MAP_STAGING_EVIDENCE[\s\S]*signed-game-staging\.json/u);
  assert.match(runtime, /ZUGFOLGE_REAL_SIGNED_MAP_EXPECTED_MANIFEST_(?:BYTES|SHA256)/u);
});

test("2026.5 bleibt ohne getrackten echten Commit-Pinvertrag rot und die Real-Audits enthalten keine Ergebnisplatzhalter", async () => {
  const [workflow, alphaAudit, stagingAudit, pins] = await Promise.all([
    text(".github/workflows/ci.yml"),
    text("tools/audits/germany-2026.5-alpha-world-runtime.real.test.mjs"),
    text("tools/audits/germany-2026.5-signed-game-staging.real.test.mjs"),
    text("tools/audits/germany-2026.5-real-acceptance-pins.mjs"),
  ]);
  const currentJobs = workflow.slice(workflow.indexOf("\n  germany-2026-5-real-builder-reproduction:"), workflow.indexOf("\n  integration-api:"));
  assert.match(currentJobs, /germany-2026\.5-real-acceptance\.pins\.json/u);
  assert.match(currentJobs, /git ls-files --error-unmatch/u);
  assert.match(currentJobs, /Realabnahme bleibt bis zum Repin geschlossen/u);
  assert.match(currentJobs, /ZUGFOLGE_REAL_GERMANY_EXPECTED_SOURCE_COMMIT/u);
  assert.match(currentJobs, /Pin-Registrierungscommit und Artefakt-Source-Commit muessen getrennt sein|PIN_REGISTRATION_COMMIT/u);
  for (const source of [currentJobs, alphaAudit, stagingAudit, pins]) {
    assert.doesNotMatch(source, /PENDING_REAL_ANNUAL_RELEASE_BUILD|PLACEHOLDER|DUMMY/u);
  }
  assert.match(alphaAudit, /loadGermany20265RealAcceptancePins/u);
  assert.match(stagingAudit, /loadGermany20265RealAcceptancePins/u);
  assert.match(alphaAudit, /ZUGFOLGE_REAL_GERMANY_2026_5_PIN_CONTRACT/u);
  assert.match(stagingAudit, /ZUGFOLGE_REAL_GERMANY_2026_5_PIN_CONTRACT/u);
  assert.doesNotMatch(alphaAudit, /throw new Error\([^\n]*Jahresrelease-Build neu gepinnt/u);
  assert.doesNotMatch(stagingAudit, /throw new Error\([^\n]*Jahresrelease-Build neu gepinnt/u);
});

test("historischer 2026.4-Dispatch bleibt als eigener unveraenderter Vertrag erhalten", async () => {
  const workflow = await text(".github/workflows/ci.yml");
  const historical = workflow.slice(
    workflow.indexOf("\n  germany-2026-4-real-acceptance:"),
    workflow.indexOf("\n  germany-2026-5-real-builder-reproduction:"),
  );
  assert.match(historical, /run_germany_2026_4_real_acceptance == true/u);
  assert.match(historical, /runs-on: \[self-hosted, linux, x64, germany-2026-4\]/u);
  assert.match(historical, /timetable-routes-v2\.transfer-demands-v1\.json/u);
  assert.match(historical, /ZUGFOLGE_OPERATIONAL_V2_REAL_RELEASE_ID=infra-deutschland-2026\.4/u);
  assert.match(historical, /alpha-world-deployment\.2026\.4\.signed\.json/u);
});
