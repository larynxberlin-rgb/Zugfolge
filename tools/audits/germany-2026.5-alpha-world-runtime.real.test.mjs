import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { isDeepStrictEqual, promisify } from "node:util";

import {
  buildAlphaWorld,
  validateAlphaWorldBuildConfiguration,
} from "../region-import/build-alpha-world.mjs";
import { loadGermany20265RealAcceptancePins } from "./germany-2026.5-real-acceptance-pins.mjs";

const execute = promisify(execFile);
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const WORLD_ID = "0db56535-a466-44a8-a991-38a8a1f7566c";
const REGION_ID = "mitteldeutschland-b";
const INFRA_RELEASE_ID = "infra-deutschland-2026.5";
const ALPHA_KEY_ID = "zugfolge-alpha-2026.3";
const MAX_NODE_RSS_BYTES = 512 * 1024 * 1024;
const COLD_CATCH_UP_DAYS = 16;
const COLD_CATCH_UP_MINIMUM_COMMANDS = 60_000;
const MAX_SCHEDULER_BATCH_COMMANDS = 256;
const MAX_SCHEDULER_BATCH_SPAN_MS = 60 * 1_000;
const MAX_NATIVE_BATCH_EVENTS = 16_384;
const REALTIME_INTERVAL_COUNT = 10;
const REALTIME_INTERVAL_MS = 60 * 1_000;
const POSTGRES_BOUNDARY = "external-postgresql-process-outside-measured-app-cgroup";
const POSTGRES_DATABASE_NAME = /^zugfolge_germany_e2e_[a-z0-9_]+$/u;
const TIMETABLE_TRANSFER_DEMANDS_FILE = "timetable-routes-v2.transfer-demands-v2.json";
const MOVEMENT_ROUTE_TEMPLATES_FILE = "operational-infrastructure-v2.movement-route-templates-v2.json";
const RUNTIME_BUILD_FILES = Object.freeze([
  "packages/planning-worker/dist/index.js",
  "packages/runtime-native/dist/index.js",
  "packages/runtime-native/dist/operational-simulation.js",
  "packages/db/dist/index.js",
  "packages/db/dist/schema/index.js",
  "packages/livemap/dist/index.js",
  "packages/dispatch/dist/index.js",
  "apps/game-api/dist/alpha-world-start.js",
  "apps/game-api/dist/regional-simulation-cycle.js",
  "apps/game-api/dist/regional-simulation-monitor.js",
  "apps/game-api/dist/regional-simulation-scheduler.js",
  "apps/game-api/dist/regional-simulation-worker.js",
  "apps/game-api/dist/world-deployment-runtime.js",
]);
function requiredAbsoluteEnvironmentPath(name) {
  const value = process.env[name];
  assert.ok(value, `${name} fehlt.`);
  assert.ok(isAbsolute(value), `${name} muss ein absoluter Pfad sein.`);
  return resolve(value);
}

function requiredCanonicalEnvironmentPin(name, expected) {
  const value = process.env[name];
  assert.ok(value, `${name} fehlt.`);
  assert.equal(value, expected, `${name} ist nicht der kanonische Deutschland-2026.5-Pin.`);
  return value;
}

function postgresAcceptanceDatabaseConfiguration(databaseUrl, boundary) {
  assert.equal(
    boundary,
    POSTGRES_BOUNDARY,
    `Deutschland-Real-E2E verlangt die bestaetigte Produktionsgrenze '${POSTGRES_BOUNDARY}'.`,
  );
  assert.ok(databaseUrl, "ZUGFOLGE_REAL_GERMANY_POSTGRES_URL fehlt.");
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    assert.fail("ZUGFOLGE_REAL_GERMANY_POSTGRES_URL ist keine gueltige URL.");
  }
  assert.ok(
    parsed.protocol === "postgres:" || parsed.protocol === "postgresql:",
    "Deutschland-Real-E2E akzeptiert ausschliesslich PostgreSQL.",
  );
  assert.ok(parsed.hostname, "PostgreSQL-Host fehlt.");
  assert.ok(parsed.username, "PostgreSQL-Benutzer fehlt.");
  assert.ok(parsed.password, "PostgreSQL-Passwort fehlt.");
  assert.equal(parsed.hash, "", "PostgreSQL-URL darf kein Fragment enthalten.");
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  assert.match(
    databaseName,
    POSTGRES_DATABASE_NAME,
    "Deutschland-Real-E2E mutiert nur eine dedizierte Datenbank zugfolge_germany_e2e_*.",
  );
  return Object.freeze({
    connectionString: parsed.toString(),
    evidence: Object.freeze({
      schema: "zugfolge-germany-e2e-postgresql-boundary/v1",
      engine: "postgresql",
      host: parsed.hostname,
      port: parsed.port || "5432",
      databaseName,
      processBoundary: POSTGRES_BOUNDARY,
      databaseProcessIncludedInMeasuredAppCgroup: false,
    }),
  });
}

function assertPostgresServerVersionNumber(value) {
  assert.ok(Number.isSafeInteger(value), "PostgreSQL server_version_num ist ungueltig.");
  assert.equal(
    Math.floor(value / 10_000),
    16,
    "Deutschland-Real-E2E ist auf PostgreSQL 16.x gebunden; Patchupdates bleiben zulaessig.",
  );
}

function parseCgroupMemoryEvents(raw) {
  const events = {};
  for (const line of raw.trim().split(/\r?\n/u)) {
    const match = /^(\S+) (\d+)$/u.exec(line);
    assert.ok(match, `cgroup-v2-memory.events ist ungueltig: '${line}'.`);
    events[match[1]] = Number(match[2]);
    assert.ok(Number.isSafeInteger(events[match[1]]));
  }
  assert.ok(Number.isSafeInteger(events.oom), "cgroup-v2-memory.events enthaelt kein oom.");
  assert.ok(Number.isSafeInteger(events.oom_kill), "cgroup-v2-memory.events enthaelt kein oom_kill.");
  return Object.freeze(events);
}

function assertNoCgroupOom(events, phase) {
  assert.ok(events, `${phase}: cgroup-v2-memory.events fehlt.`);
  assert.equal(events.oom, 0, `${phase}: cgroup-v2 meldet ein OOM-Ereignis.`);
  assert.equal(events.oom_kill, 0, `${phase}: cgroup-v2 meldet einen OOM-Kill.`);
}

function scheduledOperationalCommandAtMs(commandId, command) {
  if (command.type === "advance-to") {
    assert.ok(Number.isSafeInteger(command.atMs) && command.atMs >= 0);
    return command.atMs;
  }
  const scheduled = /^[a-f0-9]{64}:operational:[^:]+:(\d+):(\d+):(retire|materialize|dispatch)(?::.*)?$/u
    .exec(commandId);
  assert.ok(scheduled, `Operative Scheduler-Command-ID ist nicht zeitgebunden: '${commandId}'.`);
  assert.equal(scheduled[3], command.type, "Command-ID und operativer Command-Typ widersprechen sich.");
  const day = Number(scheduled[1]);
  const departureOffsetMs = Number(scheduled[2]);
  const atMs = day * 86_400_000 + departureOffsetMs;
  assert.ok(Number.isSafeInteger(atMs) && atMs >= 0);
  if (command.type === "materialize") {
    assert.equal(command.train.scheduledDepartureMs, atMs);
  } else if (command.type === "dispatch") {
    assert.ok(command.requests.length > 0, "Dispatch-Diagnose verlangt mindestens eine Fahranfrage.");
    for (const request of command.requests) assert.equal(request.waitingSinceMs, atMs);
  }
  return atMs;
}

function operationalRuntimeWithBatchDiagnostics(runtime) {
  let activeBatch;
  const completedBatchEventCounts = [];
  const withBatch = async (work, applyBatch) => {
    assert.equal(activeBatch, undefined, "Operative Batchdiagnose darf nicht verschachtelt werden.");
    activeBatch = new Map();
    for (const [index, item] of work.commands.entries()) {
      assert.equal(activeBatch.has(item.commandId), false, `Doppelte Command-ID '${item.commandId}'.`);
      activeBatch.set(item.commandId, Object.freeze({
        index,
        commandId: item.commandId,
        type: item.command.type,
        atMs: scheduledOperationalCommandAtMs(item.commandId, item.command),
      }));
    }
    try {
      const result = await applyBatch();
      assert.ok(
        result !== null
          && typeof result === "object"
          && Array.isArray(result.events),
        "Operative Batchdiagnose erhielt kein typisiertes Ereignisarray.",
      );
      completedBatchEventCounts.push(result.events.length);
      return result;
    } finally {
      activeBatch = undefined;
    }
  };
  const wrappedRuntime = Object.freeze({
    commandHash: (command) => runtime.commandHash(command),
    initialize: (input) => runtime.initialize(input),
    restore: (state, expectedInitializationHash) => runtime.restore(
      state,
      expectedInitializationHash,
    ),
    applyBatch: (state, batch) => runtime.applyBatch(state, batch),
    apply: async (state, command) => {
        try {
          return await runtime.apply(state, command);
        } catch (cause) {
          const metadata = activeBatch?.get(command.commandId);
          if (metadata === undefined) throw cause;
          const error = new Error(
            `Operatives Batchkommando fehlgeschlagen: index=${metadata.index}, commandId='${metadata.commandId}', type='${metadata.type}', atMs=${metadata.atMs}.`,
            { cause },
          );
          error.name = "OperationalBatchCommandError";
          error.code = "operational_batch_command_failed";
          Object.assign(error, metadata);
          throw error;
        }
    },
  });
  return Object.freeze({
    runtime: wrappedRuntime,
    withBatch,
    completedBatchEventCounts,
  });
}

async function fileProof(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return Object.freeze({ bytes, sha256: hash.digest("hex") });
}

async function releaseBoundAlphaWorldBuilderInputs(artifactRoot, outputPath) {
  const configurationPath = join(artifactRoot, "alpha-world-build-configuration.json");
  const configuration = validateAlphaWorldBuildConfiguration(
    JSON.parse(await readFile(configurationPath, "utf8")),
  );
  assert.equal(configuration.timetableTransferDemands.file, TIMETABLE_TRANSFER_DEMANDS_FILE);
  assert.equal(configuration.movementRouteTemplates.file, MOVEMENT_ROUTE_TEMPLATES_FILE);
  const timetableTransferDemandsPath = join(
    artifactRoot,
    configuration.timetableTransferDemands.file,
  );
  const movementRouteTemplatesPath = join(
    artifactRoot,
    configuration.movementRouteTemplates.file,
  );
  const [timetableTransferDemands, movementRouteTemplates] = await Promise.all([
    fileProof(timetableTransferDemandsPath),
    fileProof(movementRouteTemplatesPath),
  ]);
  assert.deepEqual(
    timetableTransferDemands,
    {
      bytes: configuration.timetableTransferDemands.bytes,
      sha256: configuration.timetableTransferDemands.sha256,
    },
    "Realer Timetable-Transfer-Demands-v2-Sidecar verletzt seine releasegebundene Byte-/SHA-256-Bindung.",
  );
  assert.deepEqual(
    movementRouteTemplates,
    {
      bytes: configuration.movementRouteTemplates.bytes,
      sha256: configuration.movementRouteTemplates.sha256,
    },
    "Realer Movement-Route-Templates-v2-Sidecar verletzt seine releasegebundene Byte-/SHA-256-Bindung.",
  );
  return Object.freeze({
    argv: Object.freeze([
      configurationPath,
      join(artifactRoot, "gtfs-region-20260810-v2.json"),
      join(artifactRoot, "alpha-fleet-v2-migration/compiled/fleet-authority-release-catalog-v1.json"),
      join(artifactRoot, "map-release-free-v2/public/infra-release.json"),
      join(REPOSITORY_ROOT, "tools/region-import/specifications/economy-release-alpha-2026.1.json"),
      outputPath,
      join(artifactRoot, "public-world-deploy-configuration.json"),
      join(artifactRoot, configuration.operationalInfrastructure.file),
      join(artifactRoot, configuration.timetableRoutes.file),
      timetableTransferDemandsPath,
      movementRouteTemplatesPath,
      join(artifactRoot, "alpha-fleet-v2-migration/compiled/vehicle-catalog-compile-receipt-v4.json"),
      join(artifactRoot, "alpha-fleet-v2-migration/compiled/operational-vehicle-inventory-v2.json"),
      join(artifactRoot, "alpha-fleet-v2-migration/vehicle-catalog-source-v2.json"),
      join(artifactRoot, "alpha-fleet-v2-migration/vehicle-world-seed-v3.json"),
      join(artifactRoot, "alpha-fleet-v2-migration/compiled/vehicle-catalog-v3.json"),
    ]),
    sidecars: Object.freeze({
      timetableTransferDemands: Object.freeze({
        file: configuration.timetableTransferDemands.file,
        ...timetableTransferDemands,
      }),
      movementRouteTemplates: Object.freeze({
        file: configuration.movementRouteTemplates.file,
        ...movementRouteTemplates,
        stateHash: configuration.movementRouteTemplates.stateHash,
        operationalStateHash: configuration.movementRouteTemplates.operationalStateHash,
        timetableTransferSetSha256:
          configuration.movementRouteTemplates.timetableTransferSetSha256,
      }),
    }),
  });
}

async function runtimeBuildProof(
  addonPath,
  expectedAddonSha256,
  expectedTypescriptBuildSetSha256,
  runtimeFiles = RUNTIME_BUILD_FILES.map((file) => Object.freeze({
    file,
    path: join(REPOSITORY_ROOT, file),
  })),
) {
  assert.ok(isAbsolute(addonPath), "NAPI-Runtimepfad muss absolut sein.");
  const nativeAddon = await fileProof(addonPath);
  let expectedSha256Verified = false;
  if (expectedAddonSha256 !== undefined) {
    assert.match(expectedAddonSha256, /^[a-f0-9]{64}$/u, "Erwarteter NAPI-SHA-256 ist ungueltig.");
    assert.equal(nativeAddon.sha256, expectedAddonSha256, "NAPI-Runtime weicht vom expliziten Expected-SHA-256 ab.");
    expectedSha256Verified = true;
  }
  const typescriptModules = [];
  for (const runtimeFile of runtimeFiles) {
    typescriptModules.push(Object.freeze({
      file: runtimeFile.file,
      ...await fileProof(runtimeFile.path),
    }));
  }
  const typescriptBuildSetSha256 = createHash("sha256")
    .update(JSON.stringify(typescriptModules))
    .digest("hex");
  let expectedTypescriptBuildSetSha256Verified = false;
  if (expectedTypescriptBuildSetSha256 !== undefined) {
    assert.match(
      expectedTypescriptBuildSetSha256,
      /^[a-f0-9]{64}$/u,
      "Erwarteter TypeScript-Build-Set-SHA-256 ist ungueltig.",
    );
    assert.equal(
      typescriptBuildSetSha256,
      expectedTypescriptBuildSetSha256,
      "TypeScript-Runtime weicht vom expliziten Expected-Build-Set-SHA-256 ab.",
    );
    expectedTypescriptBuildSetSha256Verified = true;
  }
  return Object.freeze({
    schema: "zugfolge-germany-runtime-build-proof/v1",
    nativeAddon: Object.freeze({
      file: basename(addonPath),
      ...nativeAddon,
      expectedSha256: expectedAddonSha256 ?? null,
      expectedSha256Verified,
    }),
    typescriptModules: Object.freeze(typescriptModules),
    typescriptBuildSetSha256,
    expectedTypescriptBuildSetSha256: expectedTypescriptBuildSetSha256 ?? null,
    expectedTypescriptBuildSetSha256Verified,
  });
}

function assertExactReusedReleaseCandidate({
  unsignedDocument,
  signedDocument,
  signed,
  unsignedProof,
  signedProof,
  expectedDeploymentHash,
  expectedUnsigned,
  expectedSigned,
}) {
  assert.deepEqual(
    unsignedDocument.deployment,
    signedDocument.deployment,
    "Wiederverwendetes unsigned und signed Deployment enthalten nicht exakt denselben Weltvertrag.",
  );
  assert.equal(signed.deploymentHash, expectedDeploymentHash, "Deployment-Hash weicht vom finalen Deutschland-2026.5-Kandidaten ab.");
  assert.deepEqual(unsignedProof, expectedUnsigned, "Unsigned Deployment verletzt seinen finalen Datei-Pin.");
  assert.deepEqual(signedProof, expectedSigned, "Signed Deployment verletzt seinen finalen Datei-Pin.");
  return Object.freeze({
    schema: "zugfolge-germany-alpha-release-candidate-proof/v1",
    exactCandidateVerified: true,
    unsignedAndSignedDeploymentEqual: true,
    deploymentHash: signed.deploymentHash,
    unsignedDeployment: unsignedProof,
    signedDeployment: signedProof,
  });
}

function acceptanceDecision({
  sourceCheckout,
  reuseCandidate,
  runtimeBuild,
  runtimeEvidence,
  platform,
  requireCgroupLimit,
  cgroupMemoryMaxBytes,
  cgroupMemoryPeakBytes,
  cgroupSwapMaxBytes,
  cgroupMemoryEventsBefore,
  cgroupMemoryEventsAfter,
}) {
  const realtimeIntervals = runtimeEvidence?.realtimeIntervals;
  const intervalHeads = Array.isArray(realtimeIntervals?.intervals)
    ? realtimeIntervals.intervals
    : [];
  const initialRealtimeHead = realtimeIntervals?.initialHead;
  const validInitialRealtimeHead = initialRealtimeHead !== null
    && typeof initialRealtimeHead === "object"
    && Number.isSafeInteger(initialRealtimeHead.nowMs)
    && Number.isSafeInteger(initialRealtimeHead.revision)
    && Number.isSafeInteger(initialRealtimeHead.publisherSequence)
    && Number.isSafeInteger(initialRealtimeHead.commitSequence)
    && initialRealtimeHead.publisherSequence === initialRealtimeHead.revision
    && initialRealtimeHead.commitSequence === initialRealtimeHead.revision;
  const exactRealtimeProgression = validInitialRealtimeHead
    && intervalHeads.length === REALTIME_INTERVAL_COUNT
    && intervalHeads.every((interval, index) => {
      const previous = index === 0
        ? initialRealtimeHead
        : intervalHeads[index - 1];
      return interval !== null
        && typeof interval === "object"
        && previous !== null
        && typeof previous === "object"
        && interval.interval === index + 1
        && interval.targetNowMs === initialRealtimeHead.nowMs
          + (index + 1) * REALTIME_INTERVAL_MS
        && interval.nowMs === interval.targetNowMs
        && Number.isSafeInteger(interval.revision)
        && interval.revision > previous.revision
        && interval.publisherSequence === interval.revision
        && interval.commitSequence === interval.revision;
    });
  const runtimeIsolation = runtimeEvidence?.runtimeIsolation;
  const isolationCounts = [
    runtimeIsolation?.beforeWorldMutation,
    runtimeIsolation?.afterRealtimeIntervals,
  ];
  const emptyEconomyAndOdooQueues = isolationCounts.every((snapshot) => snapshot !== null
    && typeof snapshot === "object"
    && snapshot.economyOutboxRows === 0
    && snapshot.economyPendingRows === 0
    && snapshot.odooProjectionOutboxRows === 0
    && snapshot.odooProjectionPendingRows === 0
    && snapshot.odooCommandQueueRows === 0
    && snapshot.odooCommandPendingRows === 0);
  const noTutorialInteraction = isolationCounts.every((snapshot) => snapshot !== null
    && typeof snapshot === "object"
    && snapshot.tutorialSessionRows === 0
    && snapshot.tutorialTelemetryRows === 0);
  const gates = Object.freeze({
    exactSourceCheckout: sourceCheckout.acceptanceEligible === true,
    exactSignedReleaseCandidate: reuseCandidate?.exactCandidateVerified === true,
    expectedNativeAddon: runtimeBuild.nativeAddon.expectedSha256Verified === true,
    expectedTypescriptBuildSet: runtimeBuild.expectedTypescriptBuildSetSha256Verified === true,
    linuxCgroupV2: platform === "linux" && requireCgroupLimit === true,
    exactMemoryMax: cgroupMemoryMaxBytes === MAX_NODE_RSS_BYTES,
    noSwap: cgroupSwapMaxBytes === 0,
    peakWithinLimit: Number.isSafeInteger(cgroupMemoryPeakBytes)
      && cgroupMemoryPeakBytes <= MAX_NODE_RSS_BYTES,
    noOomBefore: cgroupMemoryEventsBefore?.oom === 0 && cgroupMemoryEventsBefore?.oom_kill === 0,
    noOomAfter: cgroupMemoryEventsAfter?.oom === 0 && cgroupMemoryEventsAfter?.oom_kill === 0,
    tenConsecutiveRealtimeIntervals: realtimeIntervals?.intervalCount === REALTIME_INTERVAL_COUNT
      && realtimeIntervals.intervalMs === REALTIME_INTERVAL_MS
      && exactRealtimeProgression,
    schedulerCurrentThroughout: intervalHeads.length === REALTIME_INTERVAL_COUNT
      && intervalHeads.every((interval) =>
        interval !== null
        && typeof interval === "object"
        && isDeepStrictEqual(interval.schedulerReadiness, { status: "ok", code: "scheduler_current" })),
    livemapFreshThroughout: intervalHeads.length === REALTIME_INTERVAL_COUNT
      && intervalHeads.every((interval) =>
        interval !== null
        && typeof interval === "object"
        && isDeepStrictEqual(interval.livemapReadiness, { status: "ok", code: "livemap_fresh" })),
    emptyEconomyAndOdooQueues,
    noTutorialInteraction,
  });
  return Object.freeze({
    schema: "zugfolge-germany-alpha-e2e-eligibility/v2",
    eligible: Object.values(gates).every(Boolean),
    gates,
  });
}

async function sourceCheckoutProof(
  repositoryRoot = REPOSITORY_ROOT,
  allowDirtyDebug = process.env.ZUGFOLGE_REAL_GERMANY_ALLOW_DIRTY_SOURCE_FOR_DEBUG === "1",
) {
  const [{ stdout: rawHead }, { stdout: workingTreeStatus }] = await Promise.all([
    execute("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
    execute("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repositoryRoot,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
  ]);
  const gitHead = rawHead.trim();
  assert.match(gitHead, /^[a-f0-9]{40}$/u, "git HEAD ist keine vollstaendige Commit-SHA.");
  if (!allowDirtyDebug) {
    assert.equal(
      workingTreeStatus,
      "",
      `Deutschland-E2E verlangt vor dem Lauf einen Checkout ohne getrackte oder nicht ignorierte ungetrackte Abweichungen:\n${workingTreeStatus}`,
    );
  }
  return Object.freeze({
    gitHead,
    workingTreeStatus: workingTreeStatus === "" ? "clean" : "dirty-debug-only",
    acceptanceEligible: workingTreeStatus === "",
    verification: "git-rev-parse-head-and-status-porcelain-including-untracked/v1",
  });
}

async function verifyRenderedAuthoritiesBeforeMutation(signed) {
  assert.ok(
    process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH,
    "Deutschland-Real-E2E verlangt das gebaute NAPI-Runtimebinary.",
  );
  const [{ parsePlanningInfrastructureRelease }, { loadOperatingRuntime }] = await Promise.all([
    import("../../packages/planning-worker/dist/index.js"),
    import("../../packages/runtime-native/dist/index.js"),
  ]);
  const planning = parsePlanningInfrastructureRelease(
    signed.deployment.planning.infrastructureRelease,
    signed.deployment.worldId,
    signed.deployment.provenance.infraReleaseId,
  );
  assert.equal(planning.sourceId, signed.deployment.infraReleaseHash);
  const fleet = loadOperatingRuntime().initializeFleet(signed.deployment.fleet);
  assert.equal(fleet.state.worldId, signed.deployment.worldId);
  assert.equal(fleet.state.revision, 0);
  assert.equal(
    fleet.state.authorityReleaseHash,
    signed.deployment.blueprint.releases.fleet,
  );
  assert.match(fleet.stateHash, /^[a-f0-9]{64}$/u);
  return Object.freeze({
    schema: "zugfolge-germany-rendered-authority-proof/v1",
    verificationOrder: "after-signed-deployment-parser-before-database-mutation",
    signedDeploymentHash: signed.deploymentHash,
    fleet: Object.freeze({
      productionParser: "loadOperatingRuntime.initializeFleet",
      schemaVersion: signed.deployment.fleet.schemaVersion,
      authoritySchemaVersion: fleet.state.authorityRelease.schemaVersion,
      worldId: fleet.state.worldId,
      revision: fleet.state.revision,
      authorityReleaseHash: fleet.state.authorityReleaseHash,
      stateHash: fleet.stateHash,
      formationCount: Object.keys(fleet.state.formations).length,
      personnelDutyCount: Object.keys(fleet.state.personnelDuties).length,
      pathReservationCount: Object.keys(fleet.state.pathReservations).length,
    }),
    planning: Object.freeze({
      productionParser: "parsePlanningInfrastructureRelease",
      schemaVersion: planning.schemaVersion,
      worldId: planning.worldId,
      releaseId: planning.releaseId,
      sourceId: planning.sourceId,
      stationCount: planning.stations.length,
      segmentCount: planning.segments.length,
    }),
  });
}

async function cgroupV2MemoryMetric(name) {
  if (process.platform !== "linux") return undefined;
  const cgroup = (await readFile("/proc/self/cgroup", "utf8"))
    .split(/\r?\n/u)
    .find((line) => line.startsWith("0::"));
  if (cgroup === undefined) return undefined;
  const value = (await readFile(join("/sys/fs/cgroup", cgroup.slice(3), name), "utf8")).trim();
  if (value === "max") return undefined;
  assert.match(value, /^[0-9]+$/u, `cgroup-v2-${name} ist ungueltig.`);
  return Number(value);
}

async function cgroupV2MemoryEvents() {
  if (process.platform !== "linux") return undefined;
  const cgroup = (await readFile("/proc/self/cgroup", "utf8"))
    .split(/\r?\n/u)
    .find((line) => line.startsWith("0::"));
  if (cgroup === undefined) return undefined;
  return parseCgroupMemoryEvents(
    await readFile(join("/sys/fs/cgroup", cgroup.slice(3), "memory.events"), "utf8"),
  );
}

function sampleNodePeakRss(previousPeakBytes) {
  const kernelPeakBytes = process.resourceUsage().maxRSS * 1_024;
  return Math.max(previousPeakBytes, process.memoryUsage.rss(), kernelPeakBytes);
}

async function postgresRuntimeIsolationSnapshot(client) {
  const [row] = await client.unsafe(`
    select
      (select count(*)::int from economy_outbox) as economy_outbox_rows,
      (select count(*)::int from economy_outbox where processed_at is null) as economy_pending_rows,
      (select count(*)::int from odoo_projection_outbox) as odoo_projection_outbox_rows,
      (select count(*)::int from odoo_projection_outbox where delivered_at is null) as odoo_projection_pending_rows,
      (select count(*)::int from odoo_command_queue) as odoo_command_queue_rows,
      (select count(*)::int from odoo_command_queue where status in ('pending', 'processing', 'accepted'))
        as odoo_command_pending_rows,
      (select count(*)::int from tutorial_sessions) as tutorial_session_rows,
      (select count(*)::int from tutorial_telemetry_events) as tutorial_telemetry_rows
  `);
  const snapshot = Object.freeze({
    economyOutboxRows: row.economy_outbox_rows,
    economyPendingRows: row.economy_pending_rows,
    odooProjectionOutboxRows: row.odoo_projection_outbox_rows,
    odooProjectionPendingRows: row.odoo_projection_pending_rows,
    odooCommandQueueRows: row.odoo_command_queue_rows,
    odooCommandPendingRows: row.odoo_command_pending_rows,
    tutorialSessionRows: row.tutorial_session_rows,
    tutorialTelemetryRows: row.tutorial_telemetry_rows,
  });
  for (const [name, value] of Object.entries(snapshot)) {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `PostgreSQL-Isolationszaehler '${name}' ist ungueltig.`);
    assert.equal(value, 0, `Frische Deutschland-E2E-Datenbank besitzt unerwartete Zeilen in '${name}'.`);
  }
  return snapshot;
}

async function coldWorkerCatchUp({
  signed,
  runtime,
  runtimeEvidencePath,
  authorityRendering,
  runtimeBuild,
  database,
  sampleRss,
}) {
  const [
    { default: postgres },
    { drizzle },
    { migrate },
    { readMigrationFiles },
    databaseSchema,
    { createDatabaseHealthCheck, EXPECTED_SCHEMA_MIGRATIONS, MIGRATIONS_FOLDER },
    { createLivemapHealthCheck, LivemapRegistry },
    { OperationsRegistry },
    { RegionalSimulationWorker },
    { advanceRegionalSimulations },
    {
      createRegionalSimulationSchedulerHealthCheck,
      REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS,
      RegionalSimulationSchedulerMonitor,
    },
    { RegionalSimulationCycleCoordinator },
    { ActiveWorldDeploymentRuntime },
  ] = await Promise.all([
    import("../../apps/game-api/node_modules/postgres/src/index.js"),
    import("../../apps/game-api/node_modules/drizzle-orm/postgres-js/index.js"),
    import("../../apps/game-api/node_modules/drizzle-orm/postgres-js/migrator.js"),
    import("../../apps/game-api/node_modules/drizzle-orm/migrator.js"),
    import("../../packages/db/dist/schema/index.js"),
    import("../../packages/db/dist/index.js"),
    import("../../packages/livemap/dist/index.js"),
    import("../../packages/dispatch/dist/index.js"),
    import("../../apps/game-api/dist/regional-simulation-worker.js"),
    import("../../apps/game-api/dist/regional-simulation-scheduler.js"),
    import("../../apps/game-api/dist/regional-simulation-monitor.js"),
    import("../../apps/game-api/dist/regional-simulation-cycle.js"),
    import("../../apps/game-api/dist/world-deployment-runtime.js"),
  ]);
  assert.equal(
    REGIONAL_SIMULATION_SCHEDULER_INTERVAL_MS,
    REALTIME_INTERVAL_MS,
    "Deutschland-Real-E2E und Produktionsscheduler besitzen verschiedene 1:1-Intervalle.",
  );
  const client = postgres(database.connectionString, {
    max: 4,
    connect_timeout: 15,
    idle_timeout: 5,
  });
  try {
    const [databaseBefore] = await client.unsafe(`
      select current_database() as database_name,
             current_setting('server_version') as server_version,
             current_setting('server_version_num')::int as server_version_num,
             pg_backend_pid()::int as backend_pid,
             to_regclass('drizzle.__drizzle_migrations')::text as migration_table,
             to_regclass('public.worlds')::text as worlds_table
    `);
    assert.equal(databaseBefore.database_name, database.evidence.databaseName);
    assertPostgresServerVersionNumber(databaseBefore.server_version_num);
    assert.equal(databaseBefore.migration_table, null, "Dedizierte E2E-Datenbank enthaelt bereits ein Migrationsjournal.");
    assert.equal(databaseBefore.worlds_table, null, "Dedizierte E2E-Datenbank enthaelt bereits das Zugfolge-Schema.");
    const db = drizzle(client, { schema: databaseSchema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const expectedMigrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).map(
      ({ folderMillis, hash }) => Object.freeze({ createdAt: String(folderMillis), hash }),
    );
    assert.equal(expectedMigrations.length, EXPECTED_SCHEMA_MIGRATIONS);
    const migrationRows = await client.unsafe(`
      select created_at::text as created_at, hash
      from drizzle.__drizzle_migrations
      order by id
    `);
    const appliedMigrations = migrationRows.map(({ created_at: createdAt, hash }) => ({ createdAt, hash }));
    assert.deepEqual(
      appliedMigrations,
      expectedMigrations,
      "PostgreSQL-Migrationsjournal weicht vom gebauten Quellstand ab.",
    );
    const databaseReadiness = await createDatabaseHealthCheck(db).check();
    assert.deepEqual(databaseReadiness, { status: "ok", code: "schema_current" });
    const [freshDatabase] = await client.unsafe("select count(*)::int as world_count from worlds");
    assert.equal(freshDatabase.world_count, 0, "Dedizierte E2E-Datenbank ist nicht weltleer.");
    const isolationBeforeWorldMutation = await postgresRuntimeIsolationSnapshot(client);
    const migrationSetSha256 = createHash("sha256")
      .update(JSON.stringify(appliedMigrations))
      .digest("hex");
    const epoch = new Date(signed.deployment.worldDefinition.epoch);
    assert.equal(epoch.toISOString(), "2026-08-10T00:00:00.000Z");
    await db.insert(databaseSchema.worlds).values({
      id: WORLD_ID,
      name: signed.deployment.worldDefinition.name,
      schedulePeriodWeeks: signed.deployment.worldDefinition.schedulePeriodWeeks,
      epoch,
      worldKind: "public",
      rankingStatus: signed.deployment.worldDefinition.rankingStatus,
      lifecycleStatus: "active",
      createdAt: epoch,
    });

    const preflight = runtime.initialize(signed.deployment.regionalSimulation);
    assert.equal(preflight.validationReceipt.dynamicTrainCount, 0);
    const deploymentRuntime = new ActiveWorldDeploymentRuntime({
      activeWorlds: [],
      operationalProgramPreflight: () => preflight.validationReceipt,
    });
    const livemap = new LivemapRegistry();
    const operations = new OperationsRegistry();
    const diagnosticRuntime = operationalRuntimeWithBatchDiagnostics(runtime);
    const worker = new RegionalSimulationWorker(db, diagnosticRuntime.runtime, livemap, operations);
    const applyBatch = worker.applyBatch.bind(worker);
    worker.applyBatch = (work, persistedAt) => diagnosticRuntime.withBatch(
      work,
      () => applyBatch(work, persistedAt),
    );
    const lease = deploymentRuntime.prepareOperationalProgram(signed);
    let initialized;
    try {
      initialized = await worker.initialize(signed.deployment.regionalSimulation, epoch);
      deploymentRuntime.register(signed, epoch);
    } catch (error) {
      lease.rollback();
      throw error;
    }
    assert.equal(initialized.state.revision, 0);
    assert.equal(initialized.state.world.commitSequence, 0);
    assert.equal(initialized.validationReceipt.validationMode, "native-streaming-redb-v1");

    const targetNowMs = COLD_CATCH_UP_DAYS * 86_400_000;
    const targetAt = new Date(epoch.getTime() + targetNowMs);
    const progressEvents = [];
    let batchCount = 0;
    let maxBatchCommands = 0;
    let maxBatchSpanMs = 0;
    const advancedRegions = await advanceRegionalSimulations(
      worker,
      deploymentRuntime.realtimeRegions(),
      deploymentRuntime.worldEpochs,
      targetAt,
      deploymentRuntime,
      (progress) => {
        sampleRss();
        progressEvents.push(Object.freeze({ ...progress }));
      },
    );
    assert.equal(advancedRegions, 1);
    const batchProgress = progressEvents.filter((progress) =>
      progress.phase === "batch-started" || progress.phase === "batch-completed");
    assert.equal(batchProgress.length % 2, 0, "Scheduler meldete ein unvollstaendiges Batch-Paar.");
    let batchStartedCommandCount = 0;
    let batchCompletedCommandCount = 0;
    for (let index = 0; index < batchProgress.length; index += 2) {
      const started = batchProgress[index];
      const completed = batchProgress[index + 1];
      assert.equal(started.phase, "batch-started");
      assert.equal(completed.phase, "batch-completed");
      assert.equal(started.worldId, WORLD_ID);
      assert.equal(started.regionId, REGION_ID);
      assert.equal(completed.worldId, WORLD_ID);
      assert.equal(completed.regionId, REGION_ID);
      assert.ok(Number.isSafeInteger(started.commandCount) && started.commandCount > 0);
      assert.equal(completed.commandCount, started.commandCount);
      assert.ok(Number.isSafeInteger(started.currentNowMs) && started.currentNowMs >= 0);
      assert.ok(Number.isSafeInteger(completed.currentNowMs) && completed.currentNowMs >= started.currentNowMs);
      const batchSpanMs = completed.currentNowMs - started.currentNowMs;
      assert.ok(
        batchSpanMs <= MAX_SCHEDULER_BATCH_SPAN_MS,
        `Scheduler-Batch ueberschreitet ${MAX_SCHEDULER_BATCH_SPAN_MS} ms: ${batchSpanMs}.`,
      );
      batchCount += 1;
      batchStartedCommandCount += started.commandCount;
      batchCompletedCommandCount += completed.commandCount;
      maxBatchCommands = Math.max(maxBatchCommands, started.commandCount);
      maxBatchSpanMs = Math.max(maxBatchSpanMs, batchSpanMs);
    }
    const regionCompleted = progressEvents.filter((progress) => progress.phase === "region-completed");
    assert.equal(regionCompleted.length, 1, "Scheduler muss die erwartete Region genau einmal abschliessen.");
    assert.equal(
      progressEvents.some((progress) => progress.phase === "region-failed"),
      false,
      "Scheduler meldete einen fehlgeschlagenen Regionslauf.",
    );
    const scheduledCommandCount = regionCompleted[0].commandCount;
    assert.ok(Number.isSafeInteger(scheduledCommandCount) && scheduledCommandCount > 0);
    assert.equal(
      batchStartedCommandCount,
      scheduledCommandCount,
      "Batch-Starts decken nicht exakt den einmalig geplanten Regionslauf ab.",
    );
    assert.equal(
      batchCompletedCommandCount,
      scheduledCommandCount,
      "Batch-Abschluesse sind doppelt, fehlen oder decken nicht exakt den Regionslauf ab.",
    );
    assert.ok(
      scheduledCommandCount >= COLD_CATCH_UP_MINIMUM_COMMANDS,
      `Kalter Deutschland-Catch-up erzeugte nur ${scheduledCommandCount} echte Schedulerkommandos.`,
    );
    assert.ok(batchCount > 1);
    assert.ok(maxBatchCommands <= MAX_SCHEDULER_BATCH_COMMANDS);
    assert.ok(maxBatchSpanMs <= MAX_SCHEDULER_BATCH_SPAN_MS);
    assert.equal(
      diagnosticRuntime.completedBatchEventCounts.length,
      batchCount,
      "Native Batchdiagnose deckt nicht jeden abgeschlossenen Scheduler-Batch ab.",
    );
    const maxBatchEvents = Math.max(...diagnosticRuntime.completedBatchEventCounts);
    assert.ok(
      maxBatchEvents <= MAX_NATIVE_BATCH_EVENTS,
      `Nativer Batch ueberschreitet ${MAX_NATIVE_BATCH_EVENTS} Ereignisse: ${maxBatchEvents}.`,
    );

    const rows = await db.select().from(databaseSchema.regionalSimulationStates);
    assert.equal(rows.length, 1);
    const committed = rows[0];
    assert.equal(committed.worldId, WORLD_ID);
    assert.equal(committed.regionId, REGION_ID);
    assert.equal(committed.state.world.nowMs, targetNowMs);
    assert.equal(committed.revision, scheduledCommandCount);
    assert.equal(committed.publisherSequence, scheduledCommandCount);
    assert.equal(committed.state.world.commitSequence, scheduledCommandCount);

    let schedulerWallNowMs = targetAt.getTime();
    const restoredLivemap = new LivemapRegistry({ now: () => schedulerWallNowMs });
    const restoredWorker = new RegionalSimulationWorker(
      db,
      runtime,
      restoredLivemap,
      new OperationsRegistry(),
    );
    const restored = await restoredWorker.restore(
      WORLD_ID,
      REGION_ID,
      initialized.initializationHash,
    );
    assert.equal(restored.stateHash, committed.stateHash);
    assert.equal(restored.state.revision, committed.revision);
    assert.equal(restored.liveMap.commitSequence, committed.revision);
    assert.equal(restored.rzue.commitSequence, committed.revision);
    const expectedRegions = deploymentRuntime.realtimeRegions();
    const readyRegions = restoredWorker.readyRegions();
    assert.equal(expectedRegions.length, 1);
    assert.equal(readyRegions.length, 1);
    assert.deepEqual(
      readyRegions.map(({ worldId, regionId, initializationHash }) => ({ worldId, regionId, initializationHash })),
      expectedRegions,
    );
    assert.equal(readyRegions[0].nowMs, targetNowMs);
    const livemapHealth = createLivemapHealthCheck(
      restoredLivemap,
      REALTIME_INTERVAL_MS,
      () => schedulerWallNowMs,
      (worldId, nowMs) => deploymentRuntime.expectsLivemapFreshness(worldId, nowMs),
      (nowMs) => deploymentRuntime.realtimeWorldIds().filter(
        (worldId) => deploymentRuntime.expectsLivemapFreshness(worldId, nowMs),
      ),
    );
    const initialLivemapReadiness = await livemapHealth.check();
    assert.deepEqual(initialLivemapReadiness, { status: "ok", code: "livemap_fresh" });

    const realtimeMonitor = new RegionalSimulationSchedulerMonitor(
      schedulerWallNowMs,
      () => schedulerWallNowMs,
    );
    const schedulerHealth = createRegionalSimulationSchedulerHealthCheck(
      realtimeMonitor,
      REALTIME_INTERVAL_MS,
      () => schedulerWallNowMs,
      () => expectedRegions,
      () => restoredWorker.readyRegions(),
    );
    const structuredCycleRecords = [];
    const structuredLogger = Object.fromEntries(
      ["debug", "info", "warn", "error"].map((level) => [
        level,
        (bindings) => structuredCycleRecords.push(Object.freeze({ level, ...bindings })),
      ]),
    );
    const realtimeCoordinator = new RegionalSimulationCycleCoordinator({
      monitor: realtimeMonitor,
      logger: structuredLogger,
      intervalMs: REALTIME_INTERVAL_MS,
      now: () => schedulerWallNowMs,
      run: ({ at, reportProgress }) => advanceRegionalSimulations(
        restoredWorker,
        expectedRegions,
        deploymentRuntime.worldEpochs,
        at,
        deploymentRuntime,
        reportProgress,
      ),
    });
    const initialHead = Object.freeze({
      nowMs: committed.state.world.nowMs,
      revision: committed.revision,
      publisherSequence: committed.publisherSequence,
      commitSequence: committed.state.world.commitSequence,
      stateHash: committed.stateHash,
    });
    const realtimeIntervals = [];
    let previousHead = initialHead;
    for (let interval = 1; interval <= REALTIME_INTERVAL_COUNT; interval += 1) {
      const targetIntervalNowMs = targetNowMs + interval * REALTIME_INTERVAL_MS;
      schedulerWallNowMs = epoch.getTime() + targetIntervalNowMs;
      const intervalAt = new Date(schedulerWallNowMs);
      const cycleResult = await realtimeCoordinator.run(intervalAt);
      assert.deepEqual(
        {
          status: cycleResult.status,
          advancedRegions: cycleResult.advancedRegions,
          skippedIntervals: cycleResult.skippedIntervals,
        },
        { status: "completed", advancedRegions: 1, skippedIntervals: 0 },
        `Echter Schedulerlauf ${interval}/${REALTIME_INTERVAL_COUNT} wurde nicht exklusiv abgeschlossen.`,
      );

      const intervalRows = await db.select().from(databaseSchema.regionalSimulationStates);
      assert.equal(intervalRows.length, 1);
      const intervalHead = intervalRows[0];
      assert.equal(intervalHead.worldId, WORLD_ID);
      assert.equal(intervalHead.regionId, REGION_ID);
      assert.equal(intervalHead.state.world.nowMs, targetIntervalNowMs);
      assert.ok(
        intervalHead.revision > previousHead.revision,
        `Schedulerintervall ${interval} erhoehte die persistierte Revision nicht.`,
      );
      assert.ok(
        intervalHead.publisherSequence > previousHead.publisherSequence,
        `Schedulerintervall ${interval} erhoehte die Publisher-Sequenz nicht.`,
      );
      assert.ok(
        intervalHead.state.world.commitSequence > previousHead.commitSequence,
        `Schedulerintervall ${interval} erhoehte die Commit-Sequenz nicht.`,
      );
      assert.equal(intervalHead.publisherSequence, intervalHead.revision);
      assert.equal(intervalHead.state.world.commitSequence, intervalHead.revision);
      assert.equal(intervalHead.updatedAt.getTime(), intervalAt.getTime());

      const livemapFrame = restoredLivemap.initializedWorld(WORLD_ID)
        ?.snapshot().operationalRegions?.find(({ regionId }) => regionId === REGION_ID);
      assert.ok(livemapFrame, `Schedulerintervall ${interval} publizierte keinen Operational-v2-LiveMap-Frame.`);
      assert.equal(livemapFrame.commitSequence, intervalHead.revision);
      const schedulerReadiness = await schedulerHealth.check();
      const livemapReadiness = await livemapHealth.check();
      assert.deepEqual(schedulerReadiness, { status: "ok", code: "scheduler_current" });
      assert.deepEqual(livemapReadiness, { status: "ok", code: "livemap_fresh" });

      const recordedHead = Object.freeze({
        interval,
        scheduledAt: intervalAt.toISOString(),
        targetNowMs: targetIntervalNowMs,
        nowMs: intervalHead.state.world.nowMs,
        revision: intervalHead.revision,
        publisherSequence: intervalHead.publisherSequence,
        commitSequence: intervalHead.state.world.commitSequence,
        stateHash: intervalHead.stateHash,
        persistedAt: intervalHead.updatedAt.toISOString(),
        correlationId: cycleResult.correlationId,
        schedulerReadiness,
        livemapReadiness,
        livemapCommitSequence: livemapFrame.commitSequence,
      });
      realtimeIntervals.push(recordedHead);
      previousHead = recordedHead;
      sampleRss();
    }
    await realtimeCoordinator.close();
    const realtimeMonitorSnapshot = realtimeMonitor.snapshot();
    assert.deepEqual(
      {
        successfulCycles: realtimeMonitorSnapshot.successfulCycles,
        failedCycles: realtimeMonitorSnapshot.failedCycles,
        skippedCycles: realtimeMonitorSnapshot.skippedCycles,
        consecutiveFailures: realtimeMonitorSnapshot.consecutiveFailures,
        running: realtimeMonitorSnapshot.running,
      },
      {
        successfulCycles: REALTIME_INTERVAL_COUNT,
        failedCycles: 0,
        skippedCycles: 0,
        consecutiveFailures: 0,
        running: false,
      },
    );
    assert.equal(
      structuredCycleRecords.filter(({ event }) => event === "regional_scheduler_cycle_started").length,
      REALTIME_INTERVAL_COUNT,
    );
    assert.equal(
      structuredCycleRecords.filter(({ event }) => event === "regional_scheduler_cycle_completed").length,
      REALTIME_INTERVAL_COUNT,
    );
    assert.equal(
      structuredCycleRecords.some(({ event }) => event === "regional_scheduler_cycle_failed"
        || event === "regional_scheduler_cycle_stalled"
        || event === "regional_scheduler_cycle_skipped"),
      false,
    );
    const finalReadyRegions = restoredWorker.readyRegions();
    assert.equal(finalReadyRegions.length, 1);
    assert.equal(finalReadyRegions[0].nowMs, targetNowMs + REALTIME_INTERVAL_COUNT * REALTIME_INTERVAL_MS);
    const finalLivemapReadiness = await livemapHealth.check();
    assert.deepEqual(finalLivemapReadiness, { status: "ok", code: "livemap_fresh" });
    const isolationAfterRealtimeIntervals = await postgresRuntimeIsolationSnapshot(client);
    const peakRssBytes = sampleRss();
    assert.ok(peakRssBytes <= MAX_NODE_RSS_BYTES);

    const checkpointBytes = Buffer.byteLength(JSON.stringify(restored.state));
    assert.ok(checkpointBytes <= 16 * 1024 * 1024);
    const evidence = Object.freeze({
      schema: "zugfolge-germany-alpha-runtime-acceptance/v3",
      worldId: WORLD_ID,
      regionId: REGION_ID,
      deploymentHash: signed.deploymentHash,
      signatureKeyId: ALPHA_KEY_ID,
      infraRelease: signed.deployment.regionalSimulation.infraRelease,
      initializationHash: initialized.initializationHash,
      initialStateHash: initialized.stateHash,
      coldCatchUp: {
        epoch: epoch.toISOString(),
        targetAt: targetAt.toISOString(),
        targetNowMs,
        days: COLD_CATCH_UP_DAYS,
        scheduledCommandCount,
        batchStartedCommandCount,
        batchCompletedCommandCount,
        batchCount,
        maxBatchCommands,
        maxBatchSpanMs,
        maxBatchEvents,
        maxSchedulerBatchCommands: MAX_SCHEDULER_BATCH_COMMANDS,
        maxSchedulerBatchSpanMs: MAX_SCHEDULER_BATCH_SPAN_MS,
        maxNativeBatchEvents: MAX_NATIVE_BATCH_EVENTS,
        workerBoundary: "RegionalSimulationWorker.applyBatch",
        schedulerBoundary: "advanceRegionalSimulations",
      },
      committedRevision: committed.revision,
      committedStateHash: committed.stateHash,
      restoreHashEqual: true,
      realtimeIntervals: {
        intervalCount: REALTIME_INTERVAL_COUNT,
        intervalMs: REALTIME_INTERVAL_MS,
        clockBoundary: "explicit-world-epoch-derived-platform-instants",
        schedulerBoundary: "RegionalSimulationCycleCoordinator.run",
        workerBoundary: "RegionalSimulationWorker.applyBatch",
        initialHead,
        intervals: realtimeIntervals,
        monitor: realtimeMonitorSnapshot,
        structuredLogSummary: {
          started: REALTIME_INTERVAL_COUNT,
          completed: REALTIME_INTERVAL_COUNT,
          failed: 0,
          stalled: 0,
          skipped: 0,
          existingFailureAndRecoveryCoverage:
            "apps/game-api/src/regional-simulation-cycle.test.ts",
        },
      },
      runtimeIsolation: {
        databaseContract: "fresh-dedicated-postgresql-16-database",
        economyAndOdooContract: "no-queued-or-pending-rows-before-or-after-realtime-intervals",
        tutorialContract: "no-tutorial-session-or-telemetry-row-and-no-tutorial-service-invocation",
        beforeWorldMutation: isolationBeforeWorldMutation,
        afterRealtimeIntervals: isolationAfterRealtimeIntervals,
      },
      checkpointBytes,
      maxCheckpointBytes: 16 * 1024 * 1024,
      peakRssBytes,
      maxRssBytes: MAX_NODE_RSS_BYTES,
      validationMode: initialized.validationReceipt.validationMode,
      liveMapCommitSequence: restored.liveMap.commitSequence,
      rzueCommitSequence: restored.rzue.commitSequence,
      expectedRealtimeRegions: expectedRegions,
      restoredReadyRegions: finalReadyRegions,
      livemapReadiness: finalLivemapReadiness,
      platform: process.platform,
      acceptanceScope: "local-native-worker-external-postgresql-integration",
      excludedClaims: [
        "strato",
        "ready-http-latency",
        "full-game-api-process-restart",
        "postgres-process-cgroup-observation",
      ],
      database: {
        ...database.evidence,
        serverVersion: databaseBefore.server_version,
        serverVersionNumber: databaseBefore.server_version_num,
        serverContract: "PostgreSQL 16.x; Patchstand flexibel fuer Sicherheitsupdates",
        backendPid: databaseBefore.backend_pid,
        migrationCount: appliedMigrations.length,
        expectedMigrationCount: EXPECTED_SCHEMA_MIGRATIONS,
        migrationSetSha256,
        migrationVerification: "exact-repository-journal-created-at-and-sql-sha256/v1",
        schemaReadiness: databaseReadiness,
        freshDatabaseBeforeMutation: true,
      },
      databaseBoundary: POSTGRES_BOUNDARY,
      runtimeBoundary: "napi-rs-node-addon-with-external-postgresql-worker",
      runtimeBuild,
      authorityRendering,
    });
    await writeFile(runtimeEvidencePath, `${JSON.stringify(evidence)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return evidence;
  } finally {
    await client.end({ timeout: 5 });
  }
}

function assertCompactDeployment(signed, expectedInfraBinding) {
  assert.equal(signed.deployment.worldId, WORLD_ID);
  assert.equal(signed.deployment.deploymentRevision, 1);
  assert.equal(signed.signature.keyId, ALPHA_KEY_ID);
  assert.deepEqual(signed.deployment.regionalSimulation.infraRelease, expectedInfraBinding);
  assert.equal(signed.deployment.regionalSimulation.worldId, WORLD_ID);
  assert.equal(signed.deployment.regionalSimulation.regionId, REGION_ID);
  assert.equal(signed.deployment.regionalSimulation.nowMs, 0);
  for (const forbidden of [
    "directedEdges",
    "edgeGeometries",
    "routeVersions",
    "interlockingRoutes",
    "blockResources",
    "platformIntervals",
  ]) {
    assert.equal(
      Object.hasOwn(signed.deployment.regionalSimulation.infraRelease, forbidden),
      false,
      `Statische Operational-v2-Infrastruktur wurde als '${forbidden}' eingebettet.`,
    );
  }
}

test("PostgreSQL-Grenze des Deutschland-Real-E2E ist fail-closed und dediziert", () => {
  assert.throws(
    () => postgresAcceptanceDatabaseConfiguration(undefined, POSTGRES_BOUNDARY),
    /POSTGRES_URL fehlt/u,
  );
  assert.throws(
    () => postgresAcceptanceDatabaseConfiguration(
      "pglite://local/zugfolge_germany_e2e_test",
      POSTGRES_BOUNDARY,
    ),
    /ausschliesslich PostgreSQL/u,
  );
  assert.throws(
    () => postgresAcceptanceDatabaseConfiguration(
      "postgres://zugfolge:test@127.0.0.1:5432/postgres",
      POSTGRES_BOUNDARY,
    ),
    /dedizierte Datenbank/u,
  );
  assert.throws(
    () => postgresAcceptanceDatabaseConfiguration(
      "postgres://zugfolge:test@127.0.0.1:5432/zugfolge_germany_e2e_test",
      "database-inside-app-cgroup",
    ),
    /bestaetigte Produktionsgrenze/u,
  );
  const database = postgresAcceptanceDatabaseConfiguration(
    "postgres://zugfolge:test@127.0.0.1:55432/zugfolge_germany_e2e_ci",
    POSTGRES_BOUNDARY,
  );
  assert.deepEqual(database.evidence, {
    schema: "zugfolge-germany-e2e-postgresql-boundary/v1",
    engine: "postgresql",
    host: "127.0.0.1",
    port: "55432",
    databaseName: "zugfolge_germany_e2e_ci",
    processBoundary: POSTGRES_BOUNDARY,
    databaseProcessIncludedInMeasuredAppCgroup: false,
  });
  assert.doesNotThrow(() => assertPostgresServerVersionNumber(160_014));
  assert.doesNotThrow(() => assertPostgresServerVersionNumber(160_015));
  assert.throws(() => assertPostgresServerVersionNumber(150_012), /PostgreSQL 16\.x/u);
  assert.throws(() => assertPostgresServerVersionNumber(170_001), /PostgreSQL 16\.x/u);
  assert.throws(() => assertPostgresServerVersionNumber("160015"), /ungueltig/u);
});

test("cgroup-memory.events macht jeden OOM-Versuch fail-closed", () => {
  const clean = parseCgroupMemoryEvents("low 0\nhigh 12\nmax 3\noom 0\noom_kill 0\n");
  assert.doesNotThrow(() => assertNoCgroupOom(clean, "vor dem Lauf"));
  assert.throws(
    () => assertNoCgroupOom(parseCgroupMemoryEvents("oom 1\noom_kill 0\n"), "nach dem Lauf"),
    /OOM-Ereignis/u,
  );
  assert.throws(
    () => assertNoCgroupOom(parseCgroupMemoryEvents("oom 0\noom_kill 1\n"), "nach dem Lauf"),
    /OOM-Kill/u,
  );
  assert.throws(() => parseCgroupMemoryEvents("high 0\noom_kill 0\n"), /kein oom/u);
});

test("Checkout-Proof lehnt nicht ignorierte ungetrackte Quellen ab", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "zugfolge-germany-source-proof-"));
  try {
    await execute("git", ["init", "--quiet"], { cwd: repositoryRoot });
    await execute("git", ["config", "user.name", "Zugfolge Test"], { cwd: repositoryRoot });
    await execute("git", ["config", "user.email", "zugfolge-test@example.invalid"], { cwd: repositoryRoot });
    await writeFile(join(repositoryRoot, "tracked.txt"), "tracked\n", { encoding: "utf8", flag: "wx" });
    await execute("git", ["add", "tracked.txt"], { cwd: repositoryRoot });
    await execute("git", ["commit", "--quiet", "-m", "test fixture"], { cwd: repositoryRoot });
    const clean = await sourceCheckoutProof(repositoryRoot, false);
    assert.equal(clean.acceptanceEligible, true);
    assert.equal(clean.workingTreeStatus, "clean");

    await writeFile(join(repositoryRoot, "untracked-source.mjs"), "export const changed = true;\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await assert.rejects(
      sourceCheckoutProof(repositoryRoot, false),
      /nicht ignorierte ungetrackte Abweichungen/u,
    );
    const debug = await sourceCheckoutProof(repositoryRoot, true);
    assert.equal(debug.acceptanceEligible, false);
    assert.equal(debug.workingTreeStatus, "dirty-debug-only");
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("wiederverwendeter Releasekandidat verlangt identische Deployments und exakte Pins", () => {
  const deployment = Object.freeze({ schema: "zugfolge-alpha-world-deployment/v2", worldId: WORLD_ID });
  const unsignedProof = Object.freeze({ bytes: 10, sha256: "a".repeat(64) });
  const signedProof = Object.freeze({ bytes: 20, sha256: "b".repeat(64) });
  const input = {
    unsignedDocument: { deployment },
    signedDocument: { deployment },
    signed: { deploymentHash: "c".repeat(64) },
    unsignedProof,
    signedProof,
    expectedDeploymentHash: "c".repeat(64),
    expectedUnsigned: unsignedProof,
    expectedSigned: signedProof,
  };
  assert.equal(assertExactReusedReleaseCandidate(input).exactCandidateVerified, true);
  assert.throws(
    () => assertExactReusedReleaseCandidate({
      ...input,
      signedDocument: { deployment: { ...deployment, worldId: "different-world" } },
    }),
    /nicht exakt denselben Weltvertrag/u,
  );
  assert.throws(
    () => assertExactReusedReleaseCandidate({
      ...input,
      signedProof: { ...signedProof, sha256: "d".repeat(64) },
    }),
    /Signed Deployment verletzt/u,
  );
});

test("Runtime-Build-Proof bindet NAPI- und TypeScript-Bytes und prueft Expected-SHA fail-closed", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "zugfolge-germany-runtime-proof-"));
  try {
    const addonPath = join(outputRoot, "runtime.node");
    const modulePath = join(outputRoot, "runtime.js");
    await writeFile(addonPath, "native-runtime-bytes\n", { encoding: "utf8", flag: "wx" });
    await writeFile(modulePath, "export const runtime = true;\n", { encoding: "utf8", flag: "wx" });
    const expectedAddonSha256 = (await fileProof(addonPath)).sha256;
    const runtimeFiles = [{
      file: "dist/runtime.js",
      path: modulePath,
    }];
    const moduleProof = await fileProof(modulePath);
    const expectedTypescriptBuildSetSha256 = createHash("sha256")
      .update(JSON.stringify([{ file: "dist/runtime.js", ...moduleProof }]))
      .digest("hex");
    const proof = await runtimeBuildProof(
      addonPath,
      expectedAddonSha256,
      expectedTypescriptBuildSetSha256,
      runtimeFiles,
    );
    assert.equal(proof.nativeAddon.expectedSha256Verified, true);
    assert.equal(proof.typescriptModules.length, 1);
    assert.match(proof.typescriptBuildSetSha256, /^[a-f0-9]{64}$/u);
    assert.equal(proof.expectedTypescriptBuildSetSha256Verified, true);
    await assert.rejects(
      runtimeBuildProof(addonPath, "f".repeat(64), expectedTypescriptBuildSetSha256, runtimeFiles),
      /weicht vom expliziten Expected-SHA-256 ab/u,
    );
    await assert.rejects(
      runtimeBuildProof(addonPath, expectedAddonSha256, "f".repeat(64), runtimeFiles),
      /weicht vom expliziten Expected-Build-Set-SHA-256 ab/u,
    );
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("Alpha-Builder-Harnisch reicht beide realen Sidecars positions- und hashgebunden weiter", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "zugfolge-germany-builder-sidecars-"));
  try {
    const transferPath = join(artifactRoot, TIMETABLE_TRANSFER_DEMANDS_FILE);
    const movementPath = join(artifactRoot, MOVEMENT_ROUTE_TEMPLATES_FILE);
    await Promise.all([
      writeFile(transferPath, '{"schema":"zugfolge-timetable-transfer-demands/v2"}\n', { flag: "wx" }),
      writeFile(movementPath, '{"schema":"movement-route-templates-v2"}\n', { flag: "wx" }),
    ]);
    const [transferProof, movementProof] = await Promise.all([
      fileProof(transferPath),
      fileProof(movementPath),
    ]);
    const operationalStateHash = createHash("sha256").update("operational-state").digest("hex");
    const dailyPlanSha256 = createHash("sha256").update("daily-plan").digest("hex");
    const transferSetSha256 = createHash("sha256").update("transfer-set").digest("hex");
    const movementStateHash = createHash("sha256").update("movement-state").digest("hex");
    await writeFile(
      join(artifactRoot, "alpha-world-build-configuration.json"),
      JSON.stringify({
        schemaVersion: "zugfolge-alpha-world-build-configuration/v3",
        worldId: WORLD_ID,
        regionId: REGION_ID,
        regionVariant: "B",
        operatorId: "public",
        seed: "2026082501",
        fleetReleaseId: "fleet-alpha-mitteldeutschland-b-2026.3",
        planningAuthority: {
          accountId: "9158446f-70be-46ce-bbfa-7b4cf56215ff",
          displayName: "Aufgabentraeger Mitteldeutschland Alpha 2026",
        },
        operationalInfrastructure: {
          file: "operational-infrastructure-v2.json",
          bytes: 1,
          sha256: createHash("sha256").update("operational-file").digest("hex"),
          stateHash: operationalStateHash,
        },
        timetableRoutes: {
          file: "timetable-routes-v2.jsonseq",
          bytes: 1,
          sha256: createHash("sha256").update("timetable-routes").digest("hex"),
        },
        timetableTransferDemands: {
          file: TIMETABLE_TRANSFER_DEMANDS_FILE,
          ...transferProof,
          dailyPlanSha256,
          transferSetSha256,
        },
        movementRouteTemplates: {
          file: MOVEMENT_ROUTE_TEMPLATES_FILE,
          ...movementProof,
          stateHash: movementStateHash,
          operationalStateHash,
          timetableTransferSetSha256: transferSetSha256,
        },
      }, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" },
    );
    const outputPath = join(artifactRoot, "alpha-world-deployment.2026.5.json");
    const inputs = await releaseBoundAlphaWorldBuilderInputs(artifactRoot, outputPath);
    assert.deepEqual(inputs.argv.slice(9, 11), [transferPath, movementPath]);
    assert.deepEqual(inputs.sidecars.timetableTransferDemands, {
      file: TIMETABLE_TRANSFER_DEMANDS_FILE,
      ...transferProof,
    });
    assert.equal(inputs.sidecars.movementRouteTemplates.sha256, movementProof.sha256);

    await writeFile(movementPath, '{"schema":"movement-route-templates-v2","tampered":true}\n');
    await assert.rejects(
      releaseBoundAlphaWorldBuilderInputs(artifactRoot, outputPath),
      /Movement-Route-Templates-v2-Sidecar verletzt/u,
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("Top-level-Akzeptanz verlangt Speichergrenze und echten Zehn-Intervall-Isolationsbeleg", () => {
  const emptyIsolation = Object.freeze({
    economyOutboxRows: 0,
    economyPendingRows: 0,
    odooProjectionOutboxRows: 0,
    odooProjectionPendingRows: 0,
    odooCommandQueueRows: 0,
    odooCommandPendingRows: 0,
    tutorialSessionRows: 0,
    tutorialTelemetryRows: 0,
  });
  const initialHead = Object.freeze({
    nowMs: 1_000,
    revision: 100,
    publisherSequence: 100,
    commitSequence: 100,
  });
  const intervals = Array.from({ length: REALTIME_INTERVAL_COUNT }, (_, index) => Object.freeze({
    interval: index + 1,
    targetNowMs: initialHead.nowMs + (index + 1) * REALTIME_INTERVAL_MS,
    nowMs: initialHead.nowMs + (index + 1) * REALTIME_INTERVAL_MS,
    revision: initialHead.revision + index + 1,
    publisherSequence: initialHead.publisherSequence + index + 1,
    commitSequence: initialHead.commitSequence + index + 1,
    schedulerReadiness: { status: "ok", code: "scheduler_current" },
    livemapReadiness: { status: "ok", code: "livemap_fresh" },
  }));
  const runtimeEvidence = Object.freeze({
    realtimeIntervals: Object.freeze({
      intervalCount: REALTIME_INTERVAL_COUNT,
      intervalMs: REALTIME_INTERVAL_MS,
      initialHead,
      intervals,
    }),
    runtimeIsolation: Object.freeze({
      beforeWorldMutation: emptyIsolation,
      afterRealtimeIntervals: emptyIsolation,
    }),
  });
  const base = {
    sourceCheckout: { acceptanceEligible: true },
    reuseCandidate: { exactCandidateVerified: true },
    runtimeBuild: {
      nativeAddon: { expectedSha256Verified: true },
      expectedTypescriptBuildSetSha256Verified: true,
    },
    runtimeEvidence,
    platform: "linux",
    requireCgroupLimit: true,
    cgroupMemoryMaxBytes: MAX_NODE_RSS_BYTES,
    cgroupMemoryPeakBytes: MAX_NODE_RSS_BYTES - 1,
    cgroupSwapMaxBytes: 0,
    cgroupMemoryEventsBefore: { oom: 0, oom_kill: 0 },
    cgroupMemoryEventsAfter: { oom: 0, oom_kill: 0 },
  };
  assert.equal(acceptanceDecision(base).eligible, true);
  assert.equal(acceptanceDecision({ ...base, requireCgroupLimit: false }).eligible, false);
  assert.equal(acceptanceDecision({ ...base, platform: "win32" }).eligible, false);
  assert.equal(acceptanceDecision({ ...base, cgroupSwapMaxBytes: 1 }).eligible, false);
  assert.equal(acceptanceDecision({ ...base, cgroupMemoryEventsAfter: { oom: 1, oom_kill: 0 } }).eligible, false);
  assert.equal(
    acceptanceDecision({
      ...base,
      runtimeBuild: {
        ...base.runtimeBuild,
        expectedTypescriptBuildSetSha256Verified: false,
      },
    }).eligible,
    false,
  );
  assert.equal(
    acceptanceDecision({
      ...base,
      runtimeEvidence: {
        ...runtimeEvidence,
        realtimeIntervals: {
          ...runtimeEvidence.realtimeIntervals,
          intervals: intervals.map((interval, index) => index === 5
            ? { ...interval, livemapReadiness: { status: "down", code: "livemap_stale" } }
            : interval),
        },
      },
    }).eligible,
    false,
  );
  assert.equal(
    acceptanceDecision({
      ...base,
      runtimeEvidence: {
        ...runtimeEvidence,
        realtimeIntervals: {
          ...runtimeEvidence.realtimeIntervals,
          intervals: intervals.map((interval, index) => index === 6
            ? {
                ...interval,
                revision: intervals[index - 1].revision,
                publisherSequence: intervals[index - 1].publisherSequence,
                commitSequence: intervals[index - 1].commitSequence,
              }
            : interval),
        },
      },
    }).eligible,
    false,
  );
  assert.equal(
    acceptanceDecision({
      ...base,
      runtimeEvidence: {
        ...runtimeEvidence,
        realtimeIntervals: {
          ...runtimeEvidence.realtimeIntervals,
          intervals: intervals.slice(0, -1),
        },
      },
    }).eligible,
    false,
  );
  assert.equal(
    acceptanceDecision({
      ...base,
      runtimeEvidence: {
        ...runtimeEvidence,
        realtimeIntervals: {
          ...runtimeEvidence.realtimeIntervals,
          intervals: intervals.map((interval, index) => index === 4
            ? { ...interval, schedulerReadiness: { status: "down", code: "scheduler_stalled" } }
            : interval),
        },
      },
    }).eligible,
    false,
  );
  assert.equal(
    acceptanceDecision({
      ...base,
      runtimeEvidence: {
        ...runtimeEvidence,
        runtimeIsolation: {
          ...runtimeEvidence.runtimeIsolation,
          afterRealtimeIntervals: { ...emptyIsolation, odooCommandPendingRows: 1 },
        },
      },
    }).eligible,
    false,
  );
  assert.equal(
    acceptanceDecision({
      ...base,
      runtimeEvidence: {
        ...runtimeEvidence,
        runtimeIsolation: {
          ...runtimeEvidence.runtimeIsolation,
          afterRealtimeIntervals: { ...emptyIsolation, tutorialSessionRows: 1 },
        },
      },
    }).eligible,
    false,
  );
});

test("operative Batchdiagnose ergaenzt Ursache und exakte Command-Metadaten ohne den Lauf zu veraendern", async () => {
  const cause = new Error("operational_command_rejected: OccupiedTrack");
  const successfulResult = Object.freeze({ stateHash: "unchanged-result" });
  const calls = [];
  const commandHashResult = "command-hash";
  const initializedResult = Object.freeze({ stateHash: "initialized" });
  const restoredResult = Object.freeze({ stateHash: "restored" });
  const runtime = {
    marker: "bound-runtime",
    commandHash(command) {
      assert.equal(this.marker, "bound-runtime");
      assert.equal(command.type, "advance-to");
      return commandHashResult;
    },
    initialize(input) {
      assert.equal(this.marker, "bound-runtime");
      assert.equal(input, "initialization");
      return initializedResult;
    },
    restore(state, expectedInitializationHash) {
      assert.equal(this.marker, "bound-runtime");
      assert.equal(state, "persisted-state");
      assert.equal(expectedInitializationHash, "expected-initialization-hash");
      return restoredResult;
    },
    async apply(state, command) {
      assert.equal(this.marker, "bound-runtime");
      calls.push(Object.freeze({ state, command }));
      if (command.command.type === "retire") throw cause;
      return successfulResult;
    },
    async applyBatch(state, batch) {
      assert.equal(this.marker, "bound-runtime");
      return Object.freeze({ state, batch });
    },
  };
  const deploymentHash = "a".repeat(64);
  const retireCommandId = `${deploymentHash}:operational:${REGION_ID}:2:180000:retire:train-x`;
  const commands = Object.freeze([
    Object.freeze({
      commandId: "advance-to-ms:120000",
      command: Object.freeze({ type: "advance-to", atMs: 120_000 }),
    }),
    Object.freeze({
      commandId: retireCommandId,
      command: Object.freeze({ type: "retire", trainId: "train-before-x" }),
    }),
  ]);
  const work = Object.freeze({
    worldId: WORLD_ID,
    regionId: REGION_ID,
    commands,
  });
  const diagnostic = operationalRuntimeWithBatchDiagnostics(runtime);
  assert.strictEqual(
    diagnostic.runtime.commandHash(Object.freeze({ type: "advance-to", atMs: 1 })),
    commandHashResult,
  );
  assert.strictEqual(diagnostic.runtime.initialize("initialization"), initializedResult);
  assert.strictEqual(
    diagnostic.runtime.restore("persisted-state", "expected-initialization-hash"),
    restoredResult,
  );
  const state = Object.freeze({ revision: 0 });
  assert.deepEqual(
    await diagnostic.runtime.applyBatch(state, Object.freeze({ commands })),
    { state, batch: { commands } },
  );
  const completedBatch = Object.freeze({ events: Object.freeze([{}, {}]) });
  assert.strictEqual(
    await diagnostic.withBatch(work, async () => completedBatch),
    completedBatch,
  );
  assert.deepEqual(diagnostic.completedBatchEventCounts, [2]);
  await assert.rejects(
    diagnostic.withBatch(work, async () => {
      const firstEnvelope = Object.freeze({ commandId: commands[0].commandId, command: commands[0].command });
      assert.strictEqual(await diagnostic.runtime.apply(state, firstEnvelope), successfulResult);
      const secondEnvelope = Object.freeze({ commandId: commands[1].commandId, command: commands[1].command });
      await diagnostic.runtime.apply(state, secondEnvelope);
    }),
    (error) => {
      assert.equal(error.name, "OperationalBatchCommandError");
      assert.equal(error.code, "operational_batch_command_failed");
      assert.equal(error.index, 1);
      assert.equal(error.commandId, retireCommandId);
      assert.equal(error.type, "retire");
      assert.equal(error.atMs, 172_980_000);
      assert.strictEqual(error.cause, cause);
      assert.match(error.message, /index=1/u);
      assert.equal(error.message.includes("train-before-x"), false, "Fehlermeldung darf keine Command-Payload ausgeben.");
      return true;
    },
  );
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[0].state, state);
  assert.strictEqual(calls[0].command.command, commands[0].command);
  assert.strictEqual(calls[1].command.command, commands[1].command);
});

test("baut, signiert, startet, revisioniert und restored Deutschland-2026.5 mit externem PostgreSQL unter fester Speichergrenze", {
  skip: process.env.ZUGFOLGE_RUN_GERMANY_ALPHA_E2E === "1"
    ? false
    : "expliziter Realtest braucht ZUGFOLGE_RUN_GERMANY_ALPHA_E2E=1",
  timeout: 2 * 60 * 60 * 1_000,
}, async (context) => {
  const artifactRoot = requiredAbsoluteEnvironmentPath("ZUGFOLGE_REAL_GERMANY_2026_5_ROOT");
  const evidencePath = requiredAbsoluteEnvironmentPath("ZUGFOLGE_REAL_GERMANY_ALPHA_E2E_EVIDENCE");
  requiredAbsoluteEnvironmentPath("ZUGFOLGE_REAL_GERMANY_2026_5_PIN_CONTRACT");
  const expectedSourceCommit = process.env.ZUGFOLGE_REAL_GERMANY_EXPECTED_SOURCE_COMMIT;
  assert.match(expectedSourceCommit ?? "", /^[a-f0-9]{40}$/u, "Voller repo-gebundener Source-Commit fehlt.");
  const pinRegistrationCommit = process.env.ZUGFOLGE_REAL_GERMANY_PIN_REGISTRATION_COMMIT;
  assert.match(pinRegistrationCommit ?? "", /^[a-f0-9]{40}$/u, "Voller Pin-Registrierungscommit fehlt.");
  assert.notEqual(pinRegistrationCommit, expectedSourceCommit, "Pin-Registrierung darf keinen unmoeglichen Git-Selbstbezug behaupten.");
  const realAcceptancePins = await loadGermany20265RealAcceptancePins(expectedSourceCommit);
  const expectedInfraBinding = Object.freeze({
    schemaVersion: realAcceptancePins.operationalInfrastructure.schemaVersion,
    infraReleaseId: INFRA_RELEASE_ID,
    file: realAcceptancePins.operationalInfrastructure.file,
    bytes: realAcceptancePins.operationalInfrastructure.bytes,
    sha256: realAcceptancePins.operationalInfrastructure.sha256,
    stateHash: realAcceptancePins.operationalInfrastructure.stateHash,
  });
  const reuseDeployments = process.env.ZUGFOLGE_REAL_GERMANY_REUSE_DEPLOYMENTS === "1";
  const reuseUnsignedDeployment = process.env.ZUGFOLGE_REAL_GERMANY_REUSE_UNSIGNED_DEPLOYMENT === "1";
  assert.equal(
    reuseDeployments && reuseUnsignedDeployment,
    false,
    "Signed- und Unsigned-Wiederverwendung sind gegenseitig ausschliessende Debugpfade.",
  );
  const requireCgroupLimit = process.env.ZUGFOLGE_REAL_GERMANY_REQUIRE_CGROUP_LIMIT === "1";
  const expectedNapiSha256 = requireCgroupLimit
    ? requiredCanonicalEnvironmentPin(
        "ZUGFOLGE_REAL_GERMANY_EXPECTED_NAPI_SHA256",
        realAcceptancePins.runtimeBuild.nativeAddonSha256,
      )
    : process.env.ZUGFOLGE_REAL_GERMANY_EXPECTED_NAPI_SHA256;
  const expectedTypescriptBuildSetSha256 = requireCgroupLimit
    ? requiredCanonicalEnvironmentPin(
        "ZUGFOLGE_REAL_GERMANY_EXPECTED_TYPESCRIPT_BUILD_SET_SHA256",
        realAcceptancePins.runtimeBuild.typescriptBuildSetSha256,
      )
    : process.env.ZUGFOLGE_REAL_GERMANY_EXPECTED_TYPESCRIPT_BUILD_SET_SHA256;
  const releaseCandidatePins = reuseDeployments
    ? Object.freeze({
        deploymentHash: requiredCanonicalEnvironmentPin(
          "ZUGFOLGE_REAL_GERMANY_EXPECTED_DEPLOYMENT_HASH",
          realAcceptancePins.signedDeployment.deploymentHash,
        ),
        unsigned: Object.freeze({
          bytes: realAcceptancePins.unsignedDeployment.bytes,
          sha256: requiredCanonicalEnvironmentPin(
            "ZUGFOLGE_REAL_GERMANY_EXPECTED_UNSIGNED_DEPLOYMENT_SHA256",
            realAcceptancePins.unsignedDeployment.sha256,
          ),
        }),
        signed: Object.freeze({
          bytes: realAcceptancePins.signedDeployment.bytes,
          sha256: requiredCanonicalEnvironmentPin(
            "ZUGFOLGE_REAL_GERMANY_EXPECTED_SIGNED_DEPLOYMENT_SHA256",
            realAcceptancePins.signedDeployment.sha256,
          ),
        }),
      })
    : undefined;
  const database = postgresAcceptanceDatabaseConfiguration(
    process.env.ZUGFOLGE_REAL_GERMANY_POSTGRES_URL,
    process.env.ZUGFOLGE_REAL_GERMANY_POSTGRES_BOUNDARY,
  );
  const configuredPrivateKey = process.env.ZUGFOLGE_REAL_GERMANY_ALPHA_PRIVATE_KEY;
  if (configuredPrivateKey !== undefined) {
    assert.ok(isAbsolute(configuredPrivateKey), "ZUGFOLGE_REAL_GERMANY_ALPHA_PRIVATE_KEY muss absolut sein.");
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "zugfolge-germany-alpha-e2e-"));
  const unsignedPath = reuseDeployments || reuseUnsignedDeployment
    ? requiredAbsoluteEnvironmentPath("ZUGFOLGE_REAL_GERMANY_ALPHA_UNSIGNED_DEPLOYMENT")
    : join(outputRoot, "alpha-world-deployment.2026.5.json");
  const signedPath = reuseDeployments
    ? requiredAbsoluteEnvironmentPath("ZUGFOLGE_REAL_GERMANY_ALPHA_SIGNED_DEPLOYMENT")
    : join(outputRoot, "alpha-world-deployment.2026.5.signed.json");
  const runtimeEvidencePath = join(outputRoot, "alpha-world-runtime.2026.5.json");
  const privateKeyPath = configuredPrivateKey === undefined
    ? join(outputRoot, "ephemeral-alpha-ed25519-private.pem")
    : resolve(configuredPrivateKey);
  const nativeAddonPath = requiredAbsoluteEnvironmentPath("ZUGFOLGE_RUNTIME_NATIVE_PATH");
  let nodePeakRssBytes = sampleNodePeakRss(0);
  const rssSampler = setInterval(() => {
    nodePeakRssBytes = sampleNodePeakRss(nodePeakRssBytes);
  }, 25);
  rssSampler.unref();

  try {
    const sourceCheckout = await sourceCheckoutProof();
    assert.equal(sourceCheckout.gitHead, realAcceptancePins.sourceCommit, "Realabnahme-Pinvertrag gehoert nicht zum ausgecheckten Commit.");
    const runtimeBuild = await runtimeBuildProof(
      nativeAddonPath,
      expectedNapiSha256,
      expectedTypescriptBuildSetSha256,
    );
    const cgroupMemoryMaxBytes = await cgroupV2MemoryMetric("memory.max");
    const cgroupSwapMaxBytes = await cgroupV2MemoryMetric("memory.swap.max");
    const cgroupMemoryEventsBefore = await cgroupV2MemoryEvents();
    if (requireCgroupLimit) {
      assert.equal(process.platform, "linux", "Harter Deutschland-E2E ist ausschliesslich unter Linux akzeptanzfaehig.");
      assert.equal(reuseDeployments, true, "Harter Deutschland-E2E muss den finalen unsigned/signed Releasekandidaten wiederverwenden.");
      assert.equal(
        runtimeBuild.nativeAddon.expectedSha256Verified,
        true,
        "Harter Deutschland-E2E braucht einen explizit verifizierten NAPI-Expected-SHA-256.",
      );
      assert.equal(
        runtimeBuild.expectedTypescriptBuildSetSha256Verified,
        true,
        "Harter Deutschland-E2E braucht einen explizit verifizierten TypeScript-Build-Set-SHA-256.",
      );
      assert.equal(cgroupMemoryMaxBytes, MAX_NODE_RSS_BYTES, "Deutschland-E2E braucht exakt 512 MiB cgroup-v2-memory.max.");
      assert.equal(cgroupSwapMaxBytes, 0, "Deutschland-E2E darf die feste Speichergrenze nicht durch Swap umgehen.");
      assertNoCgroupOom(cgroupMemoryEventsBefore, "vor dem Deutschland-E2E");
    }
    let trustedKeys;
    if (configuredPrivateKey === undefined && !reuseDeployments) {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      await writeFile(
        privateKeyPath,
        privateKey.export({ type: "pkcs8", format: "pem" }),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      trustedKeys = {
        [ALPHA_KEY_ID]: publicKey.export({ type: "spki", format: "pem" }).toString(),
      };
    } else {
      const registeredKeys = JSON.parse(await readFile(join(REPOSITORY_ROOT, "ops/keys/trusted-delivery-keys.json"), "utf8"));
      assert.match(registeredKeys[ALPHA_KEY_ID] ?? "", /^-----BEGIN PUBLIC KEY-----/u);
      trustedKeys = { [ALPHA_KEY_ID]: registeredKeys[ALPHA_KEY_ID] };
    }

    const builderInputs = await releaseBoundAlphaWorldBuilderInputs(artifactRoot, unsignedPath);
    const builderResult = reuseDeployments || reuseUnsignedDeployment
      ? undefined
      : await buildAlphaWorld(builderInputs.argv);
    if (reuseDeployments) {
      context.diagnostic("Verifiziert die unmittelbar zuvor create-new gebauten und signierten finalen Deployments erneut.");
    } else if (reuseUnsignedDeployment) {
      context.diagnostic("Debug-Lauf verwendet das unmittelbar zuvor create-new gebaute unsigned Deployment und signiert ephemer neu.");
    }
    const unsigned = JSON.parse(await readFile(unsignedPath, "utf8"));
    assert.deepEqual(Object.keys(unsigned), ["deployment"]);
    assert.equal(unsigned.deployment.worldId, WORLD_ID);
    assert.ok(unsigned.deployment.regionalSimulation.trains.length > 0);
    if (builderResult !== undefined) {
      assert.equal(builderResult.worldId, WORLD_ID);
      assert.ok(builderResult.operationalTrainCount > 0);
      assert.match(builderResult.operationalInitializationHash, /^[a-f0-9]{64}$/u);
      assert.match(builderResult.operationalStateHash, /^[a-f0-9]{64}$/u);
    }

    if (!reuseDeployments) {
      const signer = join(REPOSITORY_ROOT, "tools/alpha-ops/sign-alpha-deployment.mjs");
      await execute(process.execPath, [signer, unsignedPath, privateKeyPath, ALPHA_KEY_ID, signedPath], {
        cwd: REPOSITORY_ROOT,
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    }
    const [signedDocument, unsignedProof, signedProof] = await Promise.all([
      readFile(signedPath, "utf8").then(JSON.parse),
      fileProof(unsignedPath),
      fileProof(signedPath),
    ]);
    const { parseSignedAlphaWorldDeployment } = await import("../../apps/game-api/dist/alpha-world-start.js");
    const signed = parseSignedAlphaWorldDeployment(signedDocument, trustedKeys);
    assertCompactDeployment(signed, expectedInfraBinding);
    const reuseCandidate = releaseCandidatePins === undefined
      ? undefined
      : assertExactReusedReleaseCandidate({
          unsignedDocument: unsigned,
          signedDocument,
          signed,
          unsignedProof,
          signedProof,
          expectedDeploymentHash: releaseCandidatePins.deploymentHash,
          expectedUnsigned: releaseCandidatePins.unsigned,
          expectedSigned: releaseCandidatePins.signed,
        });
    if (requireCgroupLimit) {
      assert.equal(reuseCandidate?.exactCandidateVerified, true, "Harter Deutschland-E2E braucht den exakt gepinnten Releasekandidaten.");
    }
    const authorityRendering = await verifyRenderedAuthoritiesBeforeMutation(signed);

    const {
      createRegionalSimulationSchedulerHealthCheck,
      RegionalSimulationSchedulerMonitor,
      runMonitoredRegionalSimulationCycle,
    } = await import("../../apps/game-api/dist/regional-simulation-monitor.js");
    const startedAtMs = Date.now();
    const monitor = new RegionalSimulationSchedulerMonitor(startedAtMs);
    let expectedRealtimeRegions;
    let restoredReadyRegions;
    const runtimeResult = await runMonitoredRegionalSimulationCycle(
      monitor,
      new Date(startedAtMs),
      async () => {
        assert.ok(
          process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH,
          "Deutschland-Real-E2E verlangt das gebaute NAPI-Runtimebinary.",
        );
        const {
          loadOperationalSimulationRuntime,
          OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV,
        } = await import("../../packages/runtime-native/dist/index.js");
        const previousRoots = process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
        process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = JSON.stringify({
          [INFRA_RELEASE_ID]: artifactRoot,
        });
        try {
          const runtime = loadOperationalSimulationRuntime();
          const nativeEvidence = await coldWorkerCatchUp({
            signed,
            runtime,
            runtimeEvidencePath,
            authorityRendering,
            runtimeBuild,
            database,
            sampleRss: () => {
              nodePeakRssBytes = sampleNodePeakRss(nodePeakRssBytes);
              return nodePeakRssBytes;
            },
          });
          expectedRealtimeRegions = nativeEvidence.expectedRealtimeRegions;
          restoredReadyRegions = nativeEvidence.restoredReadyRegions;
          return { stdout: JSON.stringify(nativeEvidence) };
        } finally {
          if (previousRoots === undefined) {
            delete process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
          } else {
            process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = previousRoots;
          }
        }
      },
    );
    context.diagnostic(runtimeResult.stdout.trim());
    assert.ok(expectedRealtimeRegions !== undefined);
    assert.ok(restoredReadyRegions !== undefined);
    const schedulerReadiness = await createRegionalSimulationSchedulerHealthCheck(
      monitor,
      undefined,
      Date.now,
      () => expectedRealtimeRegions,
      () => restoredReadyRegions,
    ).check();
    assert.deepEqual(schedulerReadiness, { status: "ok", code: "scheduler_current" });

    const runtimeEvidence = JSON.parse(await readFile(runtimeEvidencePath, "utf8"));
    assert.equal(runtimeEvidence.worldId, WORLD_ID);
    assert.equal(runtimeEvidence.regionId, REGION_ID);
    assert.equal(runtimeEvidence.deploymentHash, signed.deploymentHash);
    assert.ok(runtimeEvidence.committedRevision >= COLD_CATCH_UP_MINIMUM_COMMANDS);
    assert.ok(runtimeEvidence.coldCatchUp.scheduledCommandCount >= COLD_CATCH_UP_MINIMUM_COMMANDS);
    assert.equal(runtimeEvidence.committedRevision, runtimeEvidence.coldCatchUp.scheduledCommandCount);
    assert.equal(
      runtimeEvidence.coldCatchUp.batchStartedCommandCount,
      runtimeEvidence.coldCatchUp.scheduledCommandCount,
    );
    assert.equal(
      runtimeEvidence.coldCatchUp.batchCompletedCommandCount,
      runtimeEvidence.coldCatchUp.scheduledCommandCount,
    );
    assert.equal(runtimeEvidence.restoreHashEqual, true);
    assert.deepEqual(runtimeEvidence.livemapReadiness, { status: "ok", code: "livemap_fresh" });
    assert.ok(runtimeEvidence.peakRssBytes <= runtimeEvidence.maxRssBytes);
    assert.ok(runtimeEvidence.checkpointBytes <= runtimeEvidence.maxCheckpointBytes);
    assert.equal(runtimeEvidence.database.engine, "postgresql");
    assert.equal(runtimeEvidence.database.databaseProcessIncludedInMeasuredAppCgroup, false);
    assert.equal(runtimeEvidence.database.migrationCount, runtimeEvidence.database.expectedMigrationCount);
    assert.deepEqual(runtimeEvidence.database.schemaReadiness, { status: "ok", code: "schema_current" });
    assert.equal(runtimeEvidence.realtimeIntervals.intervalCount, REALTIME_INTERVAL_COUNT);
    assert.equal(runtimeEvidence.realtimeIntervals.intervalMs, REALTIME_INTERVAL_MS);
    assert.equal(runtimeEvidence.realtimeIntervals.intervals.length, REALTIME_INTERVAL_COUNT);
    assert.equal(
      runtimeEvidence.excludedClaims.includes("ten-consecutive-realtime-intervals"),
      false,
    );
    nodePeakRssBytes = sampleNodePeakRss(nodePeakRssBytes);
    assert.ok(
      nodePeakRssBytes <= MAX_NODE_RSS_BYTES,
      `Node-Peak-RSS ${nodePeakRssBytes} ueberschreitet ${MAX_NODE_RSS_BYTES}.`,
    );
    const cgroupMemoryPeakBytes = await cgroupV2MemoryMetric("memory.peak");
    const cgroupMemoryEventsAfter = await cgroupV2MemoryEvents();
    if (requireCgroupLimit) {
      assert.ok(
        cgroupMemoryPeakBytes !== undefined && cgroupMemoryPeakBytes <= MAX_NODE_RSS_BYTES,
        "Deutschland-E2E ueberschreitet die feste 512-MiB-cgroup-v2-Grenze.",
      );
      assertNoCgroupOom(cgroupMemoryEventsAfter, "nach dem Deutschland-E2E");
    }

    const sourceCheckoutAfter = await sourceCheckoutProof();
    assert.deepEqual(
      sourceCheckoutAfter,
      sourceCheckout,
      "Quellcommit oder Checkout aenderte sich waehrend des Deutschland-E2E-Laufs.",
    );
    const runtimeBuildAfter = await runtimeBuildProof(
      nativeAddonPath,
      expectedNapiSha256,
      expectedTypescriptBuildSetSha256,
    );
    assert.deepEqual(
      runtimeBuildAfter,
      runtimeBuild,
      "NAPI- oder TypeScript-Runtimebytes aenderten sich waehrend des Deutschland-E2E-Laufs.",
    );
    const [unsignedProofAfter, signedProofAfter] = await Promise.all([
      fileProof(unsignedPath),
      fileProof(signedPath),
    ]);
    assert.deepEqual(unsignedProofAfter, unsignedProof, "Unsigned Deployment aenderte sich waehrend des Deutschland-E2E-Laufs.");
    assert.deepEqual(signedProofAfter, signedProof, "Signed Deployment aenderte sich waehrend des Deutschland-E2E-Laufs.");
    const acceptance = acceptanceDecision({
      sourceCheckout,
      reuseCandidate,
      runtimeBuild,
      runtimeEvidence,
      platform: process.platform,
      requireCgroupLimit,
      cgroupMemoryMaxBytes,
      cgroupMemoryPeakBytes,
      cgroupSwapMaxBytes,
      cgroupMemoryEventsBefore,
      cgroupMemoryEventsAfter,
    });
    if (requireCgroupLimit) {
      assert.equal(
        acceptance.eligible,
        true,
        `Harter Release-E2E ist nicht akzeptanzfaehig: ${JSON.stringify(acceptance.gates)}`,
      );
    }
    const evidence = Object.freeze({
      schema: "zugfolge-germany-alpha-e2e-acceptance/v2",
      acceptanceEligible: acceptance.eligible,
      acceptance,
      worldId: WORLD_ID,
      regionId: REGION_ID,
      deploymentRevision: 1,
      deploymentHash: signed.deploymentHash,
      signature: {
        algorithm: signed.signature.algorithm,
        keyId: signed.signature.keyId,
        status: "verified",
        keySource: configuredPrivateKey === undefined && !reuseDeployments
          ? "ephemeral-debug-only"
          : "registered-local",
      },
      operationalInfrastructure: expectedInfraBinding,
      acceptanceScope: "local-native-worker-external-postgresql-integration",
      excludedClaims: runtimeEvidence.excludedClaims,
      sourceCheckout,
      pinRegistrationCommit,
      releaseCandidate: reuseCandidate ?? {
        exactCandidateVerified: false,
        mode: "ephemeral-debug-only",
      },
      unsignedDeployment: unsignedProof,
      signedDeployment: signedProof,
      builder: builderResult ?? {
        execution: reuseDeployments
          ? "reused-create-new-unsigned-and-signed-deployments"
          : "reused-create-new-unsigned-deployment-with-ephemeral-signature",
        worldId: unsigned.deployment.worldId,
        operationalTrainCount: unsigned.deployment.regionalSimulation.trains.length,
      },
      builderSidecars: builderInputs.sidecars,
      runtimeBuild,
      authorityRendering,
      runtime: runtimeEvidence,
      readiness: {
        scheduler: schedulerReadiness,
        livemap: runtimeEvidence.livemapReadiness,
      },
      nodePeakRssBytes,
      maxNodeRssBytes: MAX_NODE_RSS_BYTES,
      memoryLimit: {
        mode: requireCgroupLimit ? "cgroup-v2-memory-max-without-swap" : "per-process-kernel-peak",
        scope: requireCgroupLimit
          ? "entire-application-e2e-cgroup-excluding-external-postgresql-service"
          : "node-process-only-not-hard-enforced",
        cgroupMemoryMaxBytes,
        cgroupMemoryPeakBytes,
        cgroupSwapMaxBytes,
        cgroupMemoryEventsBefore,
        cgroupMemoryEventsAfter,
      },
    });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    context.diagnostic(`Deutschland-Alpha-E2E-Evidence create-new geschrieben: ${evidencePath}`);
  } finally {
    clearInterval(rssSampler);
    if (process.env.ZUGFOLGE_REAL_GERMANY_KEEP_E2E_OUTPUT !== "1") {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }
});
