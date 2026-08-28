import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  captureGermanyOperationalInfrastructureV2NativeReceipt,
  GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_ENTRYPOINT,
  GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_SCHEMA,
  GERMANY_OPERATIONAL_PUBLICATION_ENTRYPOINT,
  GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES,
  GERMANY_OPERATIONAL_PUBLICATION_RECEIPT_SCHEMA,
  GERMANY_OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE_SCHEMA,
  inspectGermanyOperationalInfrastructureV2Publication,
  publishGermanyOperationalInfrastructureV2FromNativeReceipt,
  recoverGermanyOperationalInfrastructureV2Publication,
  serializeGermanyOperationalPublicationJson,
  verifyGermanyOperationalInfrastructureV2PublicationReceipt,
} from "./operational-infrastructure-v2-publication.mjs";
import {
  GERMANY_OPERATIONAL_COMPLETE_ROUTE_COVERAGE,
  GERMANY_OPERATIONAL_CONSERVATIVE_MODE,
  GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID,
  GERMANY_OPERATIONAL_CONSERVATIVE_SCHEMA,
  GERMANY_OPERATIONAL_NATIVE_RECEIPT_SCHEMA,
  GERMANY_OPERATIONAL_NATIVE_REPORT_SCHEMA,
} from "./operational-infrastructure-v2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE_SCRIPT = join(HERE, "capture-operational-infrastructure-v2-native-receipt.mjs");
const PUBLISHER_SCRIPT = join(HERE, "publish-operational-infrastructure-v2.mjs");
const PUBLICATION_MODULE = join(HERE, "operational-infrastructure-v2-publication.mjs");
const EXECUTION_SOURCE_FILES = Object.freeze({
  wrapper: PUBLISHER_SCRIPT,
  implementation: PUBLICATION_MODULE,
  operationalDeriver: join(HERE, "operational-infrastructure-v2.mjs"),
  materializer: join(HERE, "..", "materialize-operational-infrastructure-v2.mjs"),
  createNewOutput: join(HERE, "..", "..", "tiles", "create-new-output.mjs"),
  operationalBinding: join(HERE, "..", "operational-infrastructure-binding.mjs"),
  validatorRebuildBootstrap: join(HERE, "operational-validator-rebuild-bootstrap.mjs"),
  validatorRebuildVerifier: join(HERE, "operational-validator-rebuild-evidence.mjs"),
});
const RELEASE_ID = "infra-deutschland-2026.3";
const STATE_HASH = "1".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalHash(value) {
  return sha256(JSON.stringify(canonicalValue(value)));
}

function specification() {
  return {
    schema: GERMANY_OPERATIONAL_CONSERVATIVE_SCHEMA,
    mode: GERMANY_OPERATIONAL_CONSERVATIVE_MODE,
    infraReleaseId: RELEASE_ID,
    layers: {
      tracks: "var/input/tracks.geojsonseq",
      platforms: "var/input/platforms.geojsonseq",
      switches: "var/input/switches.geojsonseq",
      signals: "var/input/signals.geojsonseq",
      blocks: "var/input/blocks.geojsonseq",
      conflictResources: "var/input/conflict-resources.geojsonseq",
      timetableRoutes: "var/input/timetable-routes-v2.jsonseq",
      transferDemands: null,
    },
    policy: {
      id: GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID,
      qualityClass: "B",
      sourceId: "zugfolge-synthetic-operational-model",
      derivationRule: GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID,
      unknownMainlineSpeedKmh: 20,
      unknownServiceSpeedKmh: 10,
      unknownGradientAbsPermille: 40,
      minimumPlatformLengthMm: 60_000,
      maximumPlatformSnapDistanceMm: 25_000,
      minimumOverlapMm: 200_000,
      minimumBerthEndClearanceMm: 10_000,
      maximumStablingPathEdges: 32,
      maximumStablingPathLengthMm: 5_000_000,
      simulatedOperationalBerthFallback: "real-osm-service-yard-then-spur-then-unclassified-rail/v1",
      maximumDirectDwellMs: 1_200_000,
      terminalFormationLengthsMm: [46_560, 69_860],
      defaultProtectionSystem: "pzb",
      regionBoundaryId: "region:deutschland-ebo",
      rzueLayoutId: "rzue-deutschland-2026.3-synthetic-b-v2",
    },
  };
}

function movementSidecar() {
  const value = {
    schema: "movement-route-templates-v2",
    infraReleaseId: RELEASE_ID,
    operationalStateHash: STATE_HASH,
    timetableTransferSetSha256: null,
    directTemplates: [],
    templates: [],
    transferTemplates: [],
    metrics: {
      directTemplateCount: 0,
      stablingTemplateCount: 0,
      transferTemplateCount: 0,
      transferDemandCount: 0,
      turnaroundDemandCount: 0,
      plannedTransitionCount: 0,
      turnaroundPairCount: 0,
      observedStablingTemplateCount: 0,
      simulatedOperationalStablingTemplateCount: 0,
      berthAssignmentCounts: { observedOsmServiceSiding: 0, simulatedOperationalOsmServiceYard: 0, simulatedOperationalOsmServiceSpur: 0, simulatedOperationalOsmUnclassifiedRail: 0 },
      crossBerthTemplateCount: 0,
    },
  };
  return { ...value, stateHash: canonicalHash({ schema: "movement-route-templates-v2", value }) };
}

function movementProof(bytesOrProof, file) {
  const proof = Buffer.isBuffer(bytesOrProof)
    ? { bytes: bytesOrProof.length, sha256: sha256(bytesOrProof) }
    : bytesOrProof;
  return {
    file,
    ...proof,
    stateHash: movementSidecar().stateHash,
    operationalStateHash: STATE_HASH,
    timetableTransferSetSha256: null,
    berthAssignmentCounts: { observedOsmServiceSiding: 0, simulatedOperationalOsmServiceYard: 0, simulatedOperationalOsmServiceSpur: 0, simulatedOperationalOsmUnclassifiedRail: 0 },
    crossBerthTemplateCount: 0,
  };
}

function candidate() {
  return { id: RELEASE_ID, fixture: "native-streaming-validated" };
}

function report(spec, specBytes, candidateBytes, sidecarBytes, sidecarFile) {
  const evidence = (path) => ({ path, bytes: 1, sha256: "2".repeat(64), records: 1 });
  return {
    schema: GERMANY_OPERATIONAL_NATIVE_REPORT_SCHEMA,
    mode: GERMANY_OPERATIONAL_CONSERVATIVE_MODE,
    infraReleaseId: RELEASE_ID,
    policy: { id: spec.policy.id, sha256: canonicalHash(spec.policy), spec: spec.policy },
    inputs: {
      spec: { path: "specification.json", bytes: specBytes.length, sha256: sha256(specBytes), records: 1 },
      tracks: evidence(spec.layers.tracks),
      platforms: evidence(spec.layers.platforms),
      switches: evidence(spec.layers.switches),
      signals: evidence(spec.layers.signals),
      blocks: evidence(spec.layers.blocks),
      conflictResources: evidence(spec.layers.conflictResources),
      timetableRoutes: evidence(spec.layers.timetableRoutes),
      transferDemands: null,
    },
    candidate: { bytes: candidateBytes.length, sha256: sha256(candidateBytes), stateHash: STATE_HASH, validationMode: "native-streaming-redb-v1", movementRouteTemplates: movementProof(sidecarBytes, sidecarFile) },
    timetableRouteEvidence: null,
    counts: {
      source: { tracks: 1, orderableTracks: 1, platforms: 0, switches: 0, signals: 0, blocks: 0, conflictResources: 0, timetableRoutes: 1, timetableLegs: 1, transferDemands: 0, transferLots: 0, turnaroundDemands: 0, turnaroundPairs: 0 },
      candidate: { directedEdges: 1, edgeGeometries: 1, routeVersions: 1, interlockingRoutes: 1, signals: 1, switches: 0, blockResources: 3, platformIntervals: 0, regionBoundaries: 1, directTemplates: 0, stablingTemplates: 0, transferTemplates: 0 },
      provenance: { observedForwardSpeeds: 1, observedBackwardSpeeds: 1, simulatedSpeeds: 0, observedProtectionAssignments: 1, simulatedProtectionAssignments: 0, matchedPlatformIntervals: 0, excludedPlatformEvidence: 0, syntheticBoundarySignals: 1, turnaroundRouteVersions: 0, turnaroundInterlockingRoutes: 0, transferRouteVersions: 0, transferInterlockingRoutes: 0, observedStablingTemplates: 0, simulatedOperationalStablingTemplates: 0, berthAssignmentCounts: { observedOsmServiceSiding: 0, simulatedOperationalOsmServiceYard: 0, simulatedOperationalOsmServiceSpur: 0, simulatedOperationalOsmUnclassifiedRail: 0 }, crossBerthTemplates: 0 },
    },
    scope: { routeModel: GERMANY_OPERATIONAL_COMPLETE_ROUTE_COVERAGE, interlockingModel: "deterministic-linear-segment-node-stellzone-mutex-and-progressive-authority/v3", platformModel: "deterministic-nearest-observed-track-within-policy-radius/v1", capacityBias: "conservative-under-capacity", minimumOverlapMmPolicy: spec.policy.minimumOverlapMm, turnaroundModel: "real-osm-bounded-bidirectional-access-with-observed-siding-or-explicit-synthetic-operational-berth/v3", minimumBerthEndClearanceMmPolicy: spec.policy.minimumBerthEndClearanceMm, maximumStablingPathEdgesPolicy: spec.policy.maximumStablingPathEdges, maximumStablingPathLengthMmPolicy: spec.policy.maximumStablingPathLengthMm, simulatedOperationalBerthFallbackPolicy: spec.policy.simulatedOperationalBerthFallback, maximumDirectDwellMsPolicy: spec.policy.maximumDirectDwellMs, terminalFormationLengthsMm: spec.policy.terminalFormationLengthsMm, movementRouteTemplateModel: "daily-plan-scoped-direct-stabling-transfer-continuity/v2" },
    routeCoverage: GERMANY_OPERATIONAL_COMPLETE_ROUTE_COVERAGE,
    activationEligible: true,
    unresolvedRequired: 0,
    unresolvedRequiredDimensions: [],
    realInterlockingFactsClaimed: false,
    realGeometry: true,
    simulatedOperationalAssignment: true,
    candidateProduced: true,
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function fixtureVerifyValidatorRebuildEvidence({ spec, receiptPath, workspaceRoot }) {
  const bytes = await readFile(receiptPath);
  const receipt = JSON.parse(bytes.toString("utf8"));
  assert.equal(receipt.schema, GERMANY_OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE_SCHEMA);
  assert.equal(receipt.releaseId, RELEASE_ID);
  assert.equal(receipt.fixtureSpecSha256, sha256(Buffer.from(`${JSON.stringify(spec)}\n`, "utf8")));
  for (const binary of Object.values(receipt.binaries)) {
    const binaryBytes = await readFile(join(workspaceRoot, ...binary.file.split("/")));
    assert.equal(binaryBytes.length, binary.bytes);
    assert.equal(sha256(binaryBytes), binary.sha256);
  }
  const implementation = receipt.producer.implementation;
  const implementationBytes = await readFile(join(workspaceRoot, ...implementation.file.split("/")));
  assert.equal(implementationBytes.length, implementation.bytes);
  assert.equal(sha256(implementationBytes), implementation.sha256);
  return { proof: { bytes: bytes.length, sha256: sha256(bytes) }, receipt };
}

async function fixtureMaterializer({ candidatePath, expectedReleaseId, outputPath, validatorExecutablePath, anchorOutput }) {
  const source = await readFile(candidatePath);
  assert.equal(JSON.parse(source).id, expectedReleaseId);
  const outputHandle = await open(outputPath, "wx", 0o600);
  try {
    await outputHandle.writeFile(source);
    await outputHandle.sync();
    await anchorOutput({ outputPath, handle: outputHandle, identity: await outputHandle.stat({ bigint: true }) });
  } finally {
    await outputHandle.close();
  }
  return {
    sourceBytes: source.length,
    sourceSha256: sha256(source),
    bytes: source.length,
    sha256: sha256(source),
    stateHash: STATE_HASH,
    validatorExecutablePath,
  };
}

async function createLargeFile(path, bytes) {
  const handle = await open(path, "wx");
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const digest = createHash("sha256");
  try {
    for (let written = 0; written < bytes; written += chunk.length) {
      const value = chunk.subarray(0, Math.min(chunk.length, bytes - written));
      await handle.write(value);
      digest.update(value);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes, sha256: digest.digest("hex") };
}

async function fixture(t, { sidecarBytes } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entrypointRoot = join(root, "tools", "region-import", "germany");
  const derived = join(root, "var", "derived", "germany-2026.3");
  await Promise.all([mkdir(entrypointRoot, { recursive: true }), mkdir(derived, { recursive: true })]);
  const captureEntrypointPath = join(root, ...GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_ENTRYPOINT.split("/"));
  const publisherEntrypointPath = join(root, ...GERMANY_OPERATIONAL_PUBLICATION_ENTRYPOINT.split("/"));
  await copyFile(CAPTURE_SCRIPT, captureEntrypointPath);
  await Promise.all(Object.entries(GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES).map(async ([id, file]) => {
    const target = join(root, ...file.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(EXECUTION_SOURCE_FILES[id], target);
  }));
  const nativeExecutablePath = join(root, "tools", "native", "zugfolge-infra-release.exe");
  await mkdir(dirname(nativeExecutablePath), { recursive: true });
  const nativeExecutableBytes = Buffer.from("native-binary-fixture\n", "utf8");
  await writeFile(nativeExecutablePath, nativeExecutableBytes, { flag: "wx" });
  const validatorRebuildExecutablePath = join(root, "tools", "native", "zugfolge-infra-release-rebuild.exe");
  const validatorRebuildExecutableBytes = Buffer.from("native-binary-rebuild-fixture\n", "utf8");
  await writeFile(validatorRebuildExecutablePath, validatorRebuildExecutableBytes, { flag: "wx" });
  const specificationPath = join(root, "tools", "region-import", "germany", "specification.json");
  const candidatePath = join(derived, "operational-infrastructure-v2.candidate.json");
  const candidateMovementRouteTemplatesPath = join(derived, "operational-infrastructure-v2.candidate.movement-route-templates-v2.json");
  const reportPath = join(derived, "operational-infrastructure-v2.derivation-report.json");
  const nativeReceiptPath = join(derived, "operational-infrastructure-v2.native-receipt.json");
  const outputPath = join(derived, "operational-infrastructure-v2.json");
  const movementRouteTemplatesPath = join(derived, "operational-infrastructure-v2.movement-route-templates-v2.json");
  const publicationReceiptPath = join(derived, "operational-infrastructure-v2.publication-receipt.json");
  const validatorRebuildSpecificationPath = join(entrypointRoot, "operational-validator-rebuild.fixture.json");
  const validatorRebuildEvidencePath = join(derived, "toolchain", "zugfolge-infra-release-rebuild-evidence.json");
  await mkdir(dirname(validatorRebuildEvidencePath), { recursive: true });
  const validatorRebuildSpec = { fixture: "typed-validator-rebuild", releaseId: RELEASE_ID };
  const validatorRebuildSpecificationBytes = Buffer.from(`${JSON.stringify(validatorRebuildSpec)}\n`, "utf8");
  await writeFile(validatorRebuildSpecificationPath, validatorRebuildSpecificationBytes, { flag: "wx" });
  const validatorRebuildVerifierBytes = await readFile(join(root, ...GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES.validatorRebuildVerifier.split("/")));
  const validatorRebuildReceipt = {
    schema: GERMANY_OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE_SCHEMA,
    releaseId: RELEASE_ID,
    specification: {
      file: "tools/region-import/germany/operational-validator-rebuild.fixture.json",
      bytes: validatorRebuildSpecificationBytes.length,
      sha256: sha256(validatorRebuildSpecificationBytes),
    },
    binaries: {
      preserved: {
        file: "tools/native/zugfolge-infra-release.exe",
        bytes: nativeExecutableBytes.length,
        sha256: sha256(nativeExecutableBytes),
      },
      rebuilt: {
        file: "tools/native/zugfolge-infra-release-rebuild.exe",
        bytes: validatorRebuildExecutableBytes.length,
        sha256: sha256(validatorRebuildExecutableBytes),
      },
    },
    source: { git: { commit: "e".repeat(40) } },
    pe: { normalized: { expectedSha256: "9".repeat(64) } },
    producer: {
      implementation: {
        file: GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES.validatorRebuildVerifier,
        bytes: validatorRebuildVerifierBytes.length,
        sha256: sha256(validatorRebuildVerifierBytes),
      },
    },
    fixtureSpecSha256: sha256(validatorRebuildSpecificationBytes),
  };
  await writeFile(validatorRebuildEvidencePath, `${JSON.stringify(validatorRebuildReceipt)}\n`, { flag: "wx" });
  const spec = specification();
  const specificationBytes = Buffer.from(`${JSON.stringify(spec)}\n`, "utf8");
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate())}\n`, "utf8");
  await Promise.all([
    writeFile(specificationPath, specificationBytes, { flag: "wx" }),
    writeFile(candidatePath, candidateBytes, { flag: "wx" }),
  ]);
  let movementBytes;
  let movementBinding;
  if (sidecarBytes === undefined) {
    movementBytes = Buffer.from(`${JSON.stringify(movementSidecar())}\n`, "utf8");
    await writeFile(candidateMovementRouteTemplatesPath, movementBytes, { flag: "wx" });
    movementBinding = movementBytes;
  } else {
    movementBinding = await createLargeFile(candidateMovementRouteTemplatesPath, sidecarBytes);
  }
  const reportValue = report(spec, specificationBytes, candidateBytes, movementBinding, basename(candidateMovementRouteTemplatesPath));
  const reportBytes = Buffer.from(`${JSON.stringify(reportValue)}\n`, "utf8");
  await writeFile(reportPath, reportBytes, { flag: "wx" });
  const nativeReceipt = {
    schema: GERMANY_OPERATIONAL_NATIVE_RECEIPT_SCHEMA,
    infraReleaseId: RELEASE_ID,
    candidate: { bytes: candidateBytes.length, sha256: sha256(candidateBytes), stateHash: STATE_HASH },
    movementRouteTemplates: movementProof(movementBinding, basename(candidateMovementRouteTemplatesPath)),
    report: { bytes: reportBytes.length, sha256: sha256(reportBytes) },
    candidateProduced: true,
    activationEligible: true,
    unresolvedRequired: 0,
  };
  const paths = { root, specificationPath, candidatePath, candidateMovementRouteTemplatesPath, reportPath, nativeReceiptPath, outputPath, movementRouteTemplatesPath, publicationReceiptPath, nativeExecutablePath, validatorRebuildExecutablePath, validatorRebuildSpecificationPath, validatorRebuildEvidencePath, captureEntrypointPath, publisherEntrypointPath };
  return { paths, nativeReceipt, candidateBytes, movementBytes };
}

async function capture(fixtureValue, nativeReceipt = fixtureValue.nativeReceipt, options = {}) {
  return captureGermanyOperationalInfrastructureV2NativeReceipt({
    nativeReceipt,
    specificationPath: fixtureValue.paths.specificationPath,
    candidatePath: fixtureValue.paths.candidatePath,
    candidateMovementRouteTemplatesPath: fixtureValue.paths.candidateMovementRouteTemplatesPath,
    reportPath: fixtureValue.paths.reportPath,
    nativeExecutablePath: fixtureValue.paths.nativeExecutablePath,
    validatorRebuildSpecificationPath: fixtureValue.paths.validatorRebuildSpecificationPath,
    validatorRebuildEvidencePath: fixtureValue.paths.validatorRebuildEvidencePath,
    outputPath: fixtureValue.paths.nativeReceiptPath,
    workspaceRoot: fixtureValue.paths.root,
    captureEntrypointPath: fixtureValue.paths.captureEntrypointPath,
    verifyValidatorRebuildEvidence: fixtureVerifyValidatorRebuildEvidence,
    ...options,
  });
}

async function publish(fixtureValue, options = {}) {
  return publishGermanyOperationalInfrastructureV2FromNativeReceipt({
    specificationPath: fixtureValue.paths.specificationPath,
    candidatePath: fixtureValue.paths.candidatePath,
    candidateMovementRouteTemplatesPath: fixtureValue.paths.candidateMovementRouteTemplatesPath,
    reportPath: fixtureValue.paths.reportPath,
    nativeReceiptPath: fixtureValue.paths.nativeReceiptPath,
    validatorRebuildSpecificationPath: fixtureValue.paths.validatorRebuildSpecificationPath,
    validatorRebuildEvidencePath: fixtureValue.paths.validatorRebuildEvidencePath,
    outputPath: fixtureValue.paths.outputPath,
    publicationReceiptPath: fixtureValue.paths.publicationReceiptPath,
    workspaceRoot: fixtureValue.paths.root,
    publisherEntrypointPath: fixtureValue.paths.publisherEntrypointPath,
    materialize: fixtureMaterializer,
    verifyValidatorRebuildEvidence: fixtureVerifyValidatorRebuildEvidence,
    ...options,
  });
}

async function assertNoVisiblePair(paths) {
  assert.equal(await exists(paths.outputPath), false);
  assert.equal(await exists(paths.movementRouteTemplatesPath), false);
  assert.equal(await exists(paths.publicationReceiptPath), false);
}

async function localModuleClosure(entrypoints) {
  const visited = new Set();
  const pending = entrypoints.map((file) => resolve(file));
  const localImport = /(?:\bfrom\s+|\bimport\s*)["'](\.\.?\/[^"']+)["']/gu;
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(localImport)) pending.push(resolve(dirname(file), match[1]));
  }
  return visited;
}

async function spawnPublisherKillpoint(value, hookName, status = 73) {
  const child = join(value.paths.root, `killpoint-${hookName}.mjs`);
  await writeFile(child, `
    import { open, readFile, writeFile } from "node:fs/promises";
    import { createHash } from "node:crypto";
    import { publishGermanyOperationalInfrastructureV2FromNativeReceipt } from ${JSON.stringify(pathToFileURL(PUBLICATION_MODULE).href)};
    const input = ${JSON.stringify(value.paths)};
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    await publishGermanyOperationalInfrastructureV2FromNativeReceipt({
      specificationPath: input.specificationPath,
      candidatePath: input.candidatePath,
      candidateMovementRouteTemplatesPath: input.candidateMovementRouteTemplatesPath,
      reportPath: input.reportPath,
      nativeReceiptPath: input.nativeReceiptPath,
      validatorRebuildSpecificationPath: input.validatorRebuildSpecificationPath,
      validatorRebuildEvidencePath: input.validatorRebuildEvidencePath,
      outputPath: input.outputPath,
      publicationReceiptPath: input.publicationReceiptPath,
      workspaceRoot: input.root,
      publisherEntrypointPath: input.publisherEntrypointPath,
      materialize: async ({ candidatePath, outputPath, validatorExecutablePath, anchorOutput }) => {
        const bytes = await readFile(candidatePath);
        const handle = await open(outputPath, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
          await anchorOutput({ outputPath, handle, identity: await handle.stat({ bigint: true }) });
        } finally {
          await handle.close();
        }
        return { sourceBytes: bytes.length, sourceSha256: hash(bytes), bytes: bytes.length, sha256: hash(bytes), stateHash: ${JSON.stringify(STATE_HASH)}, validatorExecutablePath };
      },
      verifyValidatorRebuildEvidence: async ({ receiptPath }) => {
        const bytes = await readFile(receiptPath);
        return { proof: { bytes: bytes.length, sha256: hash(bytes) }, receipt: JSON.parse(bytes.toString("utf8")) };
      },
      hooks: { ${hookName}: async () => process.exit(${status}) },
    });
  `, { flag: "wx" });
  return spawnSync(process.execPath, [child], { encoding: "utf8" });
}

async function spawnCaptureKillpoint(value, hookName, status = 76) {
  const child = join(value.paths.root, `capture-killpoint-${hookName}.mjs`);
  await writeFile(child, `
    import { readFile } from "node:fs/promises";
    import { createHash } from "node:crypto";
    import { captureGermanyOperationalInfrastructureV2NativeReceipt } from ${JSON.stringify(pathToFileURL(PUBLICATION_MODULE).href)};
    const input = ${JSON.stringify(value.paths)};
    const nativeReceipt = ${JSON.stringify(value.nativeReceipt)};
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    await captureGermanyOperationalInfrastructureV2NativeReceipt({
      nativeReceipt,
      specificationPath: input.specificationPath,
      candidatePath: input.candidatePath,
      candidateMovementRouteTemplatesPath: input.candidateMovementRouteTemplatesPath,
      reportPath: input.reportPath,
      nativeExecutablePath: input.nativeExecutablePath,
      validatorRebuildSpecificationPath: input.validatorRebuildSpecificationPath,
      validatorRebuildEvidencePath: input.validatorRebuildEvidencePath,
      outputPath: input.nativeReceiptPath,
      workspaceRoot: input.root,
      captureEntrypointPath: input.captureEntrypointPath,
      verifyValidatorRebuildEvidence: async ({ receiptPath }) => {
        const bytes = await readFile(receiptPath);
        return { proof: { bytes: bytes.length, sha256: hash(bytes) }, receipt: JSON.parse(bytes.toString("utf8")) };
      },
      hooks: { ${hookName}: async () => process.exit(${status}) },
    });
  `, { flag: "wx" });
  return spawnSync(process.execPath, [child], { encoding: "utf8" });
}

test("Capture und Publisher binden natives Receipt, Triplet, finale Paarung und Scripts create-new", async (t) => {
  const value = await fixture(t);
  const captured = await capture(value);
  assert.equal(captured.receipt.schema, GERMANY_OPERATIONAL_NATIVE_RECEIPT_CAPTURE_SCHEMA);
  const publication = await publish(value);
  assert.equal(publication.receipt.schema, GERMANY_OPERATIONAL_PUBLICATION_RECEIPT_SCHEMA);
  assert.equal(publication.receipt.publisher.entrypoint, GERMANY_OPERATIONAL_PUBLICATION_ENTRYPOINT);
  assert.deepEqual(
    Object.keys(publication.receipt.publisher.executionInventory).sort(),
    [...Object.keys(GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES), "validatorExecutable"].sort(),
  );
  assert.equal(
    publication.receipt.publisher.executionInventory.validatorExecutable.file,
    captured.receipt.producer.executable.file,
  );
  assert.deepEqual(publication.receipt.validatorRebuild, captured.receipt.validatorRebuild);
  assert.deepEqual(await readFile(value.paths.outputPath), value.candidateBytes);
  assert.deepEqual(await readFile(value.paths.movementRouteTemplatesPath), value.movementBytes);
  const verified = await verifyGermanyOperationalInfrastructureV2PublicationReceipt({ workspaceRoot: value.paths.root, publicationReceiptPath: value.paths.publicationReceiptPath, expectedReleaseId: RELEASE_ID, verifyValidatorRebuildEvidence: fixtureVerifyValidatorRebuildEvidence });
  assert.equal(verified.receipt.nativeReceipt.sha256, captured.sha256);
  assert.equal((await inspectGermanyOperationalInfrastructureV2Publication({ outputPath: value.paths.outputPath, publicationReceiptPath: value.paths.publicationReceiptPath, workspaceRoot: value.paths.root, verifyValidatorRebuildEvidence: fixtureVerifyValidatorRebuildEvidence })).status, "complete");
});

test("Publication-Receipt ist an sein kanonisches Geschwisterpaar gebunden", async (t) => {
  const value = await fixture(t);
  await capture(value);
  await publish(value);
  const other = join(value.paths.root, "var", "derived", "other-release");
  await mkdir(other, { recursive: true });
  const copiedReceipt = join(other, basename(value.paths.publicationReceiptPath));
  await copyFile(value.paths.publicationReceiptPath, copiedReceipt);
  await assert.rejects(
    verifyGermanyOperationalInfrastructureV2PublicationReceipt({
      workspaceRoot: value.paths.root,
      publicationReceiptPath: copiedReceipt,
      expectedReleaseId: RELEASE_ID,
      verifyValidatorRebuildEvidence: fixtureVerifyValidatorRebuildEvidence,
    }),
    /Geschwisterpfad|Geschwisterpaar|Publikationsverzeichnis/u,
  );
});

test("statische lokale Import-Closure ist vollstaendig inventarisiert und frei von ignoriertem Alpha-dist", async () => {
  const closure = await localModuleClosure([CAPTURE_SCRIPT, PUBLISHER_SCRIPT, EXECUTION_SOURCE_FILES.validatorRebuildBootstrap]);
  assert.deepEqual(
    [...closure].sort(),
    [
      CAPTURE_SCRIPT,
      ...Object.values(EXECUTION_SOURCE_FILES),
    ].map((file) => resolve(file)).sort(),
  );
  const bindingSource = await readFile(EXECUTION_SOURCE_FILES.operationalBinding, "utf8");
  assert.doesNotMatch(bindingSource, /packages\/alpha\/dist|\.\.\/\.\.\/packages/u);
  assert.match(bindingSource, /node:crypto/u);
});

test("fehlendes oder gefaelschtes Native-Receipt sowie Sidecar-/Berichtsdrift publizieren nichts", async (t) => {
  const forged = await fixture(t);
  const badReceipt = structuredClone(forged.nativeReceipt);
  badReceipt.movementRouteTemplates.sha256 = "0".repeat(64);
  await assert.rejects(capture(forged, badReceipt), /Movement-Sidecar|Receipt|driftet|verschieden/u);
  assert.equal(await exists(forged.paths.nativeReceiptPath), false);

  const missing = await fixture(t);
  await assert.rejects(publish(missing), (error) => error?.code === "ENOENT");
  await assertNoVisiblePair(missing.paths);

  const sidecar = await fixture(t);
  await capture(sidecar);
  await unlink(sidecar.paths.candidateMovementRouteTemplatesPath);
  await assert.rejects(publish(sidecar), (error) => error?.code === "ENOENT");
  await assertNoVisiblePair(sidecar.paths);

  const wrongSidecar = await fixture(t);
  await capture(wrongSidecar);
  await writeFile(wrongSidecar.paths.candidateMovementRouteTemplatesPath, "wrong-sidecar", { flag: "a" });
  await assert.rejects(publish(wrongSidecar), /Sidecar.*driftet|Receipt-Bindung/u);
  await assertNoVisiblePair(wrongSidecar.paths);

  const bindingMismatch = await fixture(t);
  const mismatchedReport = JSON.parse(await readFile(bindingMismatch.paths.reportPath, "utf8"));
  mismatchedReport.candidate.movementRouteTemplates.sha256 = "0".repeat(64);
  const mismatchedReportBytes = Buffer.from(`${JSON.stringify(mismatchedReport)}\n`, "utf8");
  await rm(bindingMismatch.paths.reportPath);
  await writeFile(bindingMismatch.paths.reportPath, mismatchedReportBytes, { flag: "wx" });
  const mismatchedReceipt = structuredClone(bindingMismatch.nativeReceipt);
  mismatchedReceipt.report = { bytes: mismatchedReportBytes.length, sha256: sha256(mismatchedReportBytes) };
  await assert.rejects(capture(bindingMismatch, mismatchedReceipt), /verschiedene Movement-Sidecar-Bindungen/u);
  assert.equal(await exists(bindingMismatch.paths.nativeReceiptPath), false);

  const drift = await fixture(t);
  await capture(drift);
  await writeFile(drift.paths.reportPath, "drift", { flag: "a" });
  await assert.rejects(publish(drift), /driftet|gueltiges JSON|Receipt-Bindung/u);
  await assertNoVisiblePair(drift.paths);
});

test("fehlender, falsch gebundener oder nach Capture gedrifteter Validator-Rebuild-Beleg bleibt fail-closed", async (t) => {
  const missing = await fixture(t);
  await unlink(missing.paths.validatorRebuildEvidencePath);
  await assert.rejects(capture(missing), (error) => error?.code === "ENOENT");
  assert.equal(await exists(missing.paths.nativeReceiptPath), false);

  const relabelled = await fixture(t);
  const otherValidatorPath = join(relabelled.paths.root, "tools", "native", "relabeled-validator.exe");
  await writeFile(otherValidatorPath, "relabeled-validator\n", { flag: "wx" });
  const relabelledEvidence = JSON.parse(await readFile(relabelled.paths.validatorRebuildEvidencePath, "utf8"));
  const otherBytes = await readFile(otherValidatorPath);
  relabelledEvidence.binaries.preserved = {
    file: "tools/native/relabeled-validator.exe",
    bytes: otherBytes.length,
    sha256: sha256(otherBytes),
  };
  await rm(relabelled.paths.validatorRebuildEvidencePath);
  await writeFile(relabelled.paths.validatorRebuildEvidencePath, `${JSON.stringify(relabelledEvidence)}\n`, { flag: "wx" });
  await assert.rejects(capture(relabelled), /nicht das effektiv ausgefuehrte preserved Validator-Binary/u);
  assert.equal(await exists(relabelled.paths.nativeReceiptPath), false);

  const drift = await fixture(t);
  await capture(drift);
  await writeFile(drift.paths.validatorRebuildExecutablePath, "drift", { flag: "a" });
  await assert.rejects(publish(drift), /Expected values to be strictly equal|drift/u);
  await assertNoVisiblePair(drift.paths);
});

test("Native-Receipt-Capture rollt Postlink-Fehler owned-only zurueck und erhaelt Fremdersetzungen", async (t) => {
  const changedOwnLink = await fixture(t);
  await assert.rejects(
    capture(changedOwnLink, changedOwnLink.nativeReceipt, {
      hooks: { afterNativeReceiptLink: async ({ output }) => writeFile(output, "drift", { flag: "a" }) },
    }),
    /Native-Receipt-Capture.*(?:driftet|fremd ersetzt|veraendert)/u,
  );
  assert.equal(await exists(changedOwnLink.paths.nativeReceiptPath), false);

  const foreignOutput = await fixture(t);
  await assert.rejects(
    capture(foreignOutput, foreignOutput.nativeReceipt, {
      hooks: {
        afterNativeReceiptLink: async ({ output }) => {
          await unlink(output);
          await writeFile(output, "foreign-native-receipt\n", { flag: "wx" });
        },
      },
    }),
    /driftet|fremd ersetzt|owned-only/u,
  );
  assert.equal(await readFile(foreignOutput.paths.nativeReceiptPath, "utf8"), "foreign-native-receipt\n");

  const foreignStaged = await fixture(t);
  await assert.rejects(
    capture(foreignStaged, foreignStaged.nativeReceipt, {
      hooks: {
        afterNativeReceiptLink: async ({ staged }) => {
          await unlink(staged);
          await writeFile(staged, "foreign-staged-native-receipt\n", { flag: "wx" });
        },
      },
    }),
    /Capture-Staging.*fremd ersetzt|Cleanup/u,
  );
  assert.equal(await exists(foreignStaged.paths.nativeReceiptPath), false);
  const quarantines = (await readdir(dirname(foreignStaged.paths.nativeReceiptPath)))
    .filter((name) => name.startsWith(".operational-v2-owned-cleanup-"));
  assert.equal(quarantines.length, 1);
  assert.equal(
    await readFile(join(
      dirname(foreignStaged.paths.nativeReceiptPath),
      quarantines[0],
      (await readdir(join(dirname(foreignStaged.paths.nativeReceiptPath), quarantines[0])))[0],
      basename(foreignStaged.paths.nativeReceiptPath),
    ), "utf8"),
    "foreign-staged-native-receipt\n",
  );
});

test("Native-Receipt-Capture ist nach echtem Prozess-Kill automatisch recoverbar", async (t) => {
  const value = await fixture(t);
  const killed = await spawnCaptureKillpoint(value, "afterNativeReceiptLink");
  assert.equal(killed.status, 76, `${killed.stderr}\n${killed.stdout}`);
  assert.equal(await exists(value.paths.nativeReceiptPath), true);
  assert.equal(
    await exists(join(dirname(value.paths.nativeReceiptPath), ".operational-infrastructure-v2.native-receipt-capture-claim.json")),
    true,
  );
  const recovered = await capture(value);
  assert.equal(recovered.recovery, "completed");
  assert.equal(
    await exists(join(dirname(value.paths.nativeReceiptPath), ".operational-infrastructure-v2.native-receipt-capture-claim.json")),
    false,
  );
  assert.equal(
    (await readdir(dirname(value.paths.nativeReceiptPath))).some((name) => name.startsWith(".operational-v2-native-receipt-")),
    false,
  );
});

test("Quelltausch direkt nach create-new Link und finaler Cleanup-Tausch liefern keinen stale Success", async (t) => {
  const sourceSwap = await fixture(t);
  await capture(sourceSwap);
  let foreignStagedSource;
  await assert.rejects(publish(sourceSwap, {
    hooks: {
      afterOperationalSourceLinkBeforeAudit: async ({ source }) => {
        await unlink(source);
        await writeFile(source, "foreign-staged-source\n", { flag: "wx" });
        foreignStagedSource = source;
      },
    },
  }), /quell- und zielgebundener|fremd ersetzt|Cleanup/u);
  await assertNoVisiblePair(sourceSwap.paths);
  const sourceQuarantines = (await readdir(dirname(sourceSwap.paths.outputPath)))
    .filter((name) => name.startsWith(".operational-v2-owned-cleanup-"));
  assert.ok(sourceQuarantines.length >= 1);
  assert.equal(
    (await Promise.all(sourceQuarantines.map(async (name) => {
      const root = join(dirname(sourceSwap.paths.outputPath), name);
      const matches = [];
      async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.name === basename(foreignStagedSource)) matches.push(await readFile(path, "utf8"));
        }
      }
      await walk(root);
      return matches;
    }))).flat().includes("foreign-staged-source\n"),
    true,
  );

  const finalSwap = await fixture(t);
  await capture(finalSwap);
  await assert.rejects(publish(finalSwap, {
    hooks: {
      afterPublicationCleanupBeforeFinalAudit: async ({ paths }) => {
        await unlink(paths.output);
        await writeFile(paths.output, "foreign-final-output\n", { flag: "wx" });
      },
    },
  }), /fremd ersetzt|veraendert|finalen Inspektion/u);
  assert.equal(await readFile(finalSwap.paths.outputPath, "utf8"), "foreign-final-output\n");
});

test("erster Sidecar-Ownership-Anker ist vor Linux-Inode-Reuse handlegebunden", async (t) => {
  const value = await fixture(t);
  await capture(value);
  let replaced = false;
  await assert.rejects(publish(value, {
    hooks: {
      beforeOwnershipAnchorLink: async (context) => {
        assert.equal(Object.hasOwn(context, "handle"), false);
        const { file, sourcePath } = context;
        if (replaced || file !== basename(value.paths.movementRouteTemplatesPath)) return;
        replaced = true;
        await unlink(sourcePath);
        await writeFile(sourcePath, "foreign-before-first-anchor\n", { flag: "wx" });
      },
    },
  }), /Ownership-Verankerung|fremd ersetzt|Cleanup/u);
  assert.equal(replaced, true);
  await assertNoVisiblePair(value.paths);
  const cleanupRoots = (await readdir(dirname(value.paths.outputPath)))
    .filter((name) => name.startsWith(".operational-v2-owned-cleanup-"));
  let foreignPreserved = false;
  for (const name of cleanupRoots) {
    const pending = [join(dirname(value.paths.outputPath), name)];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if ((await readFile(path, "utf8")) === "foreign-before-first-anchor\n") foreignPreserved = true;
      }
    }
  }
  assert.equal(foreignPreserved, true);
});

test("Directory-Cleanup loescht beim Check-Rename-Race keinen fremden Staging-Ersatz", async (t) => {
  const value = await fixture(t);
  await capture(value);
  let injected = false;
  await assert.rejects(publish(value, {
    hooks: {
      beforeOwnedDirectoryEntryQuarantineRename: async ({ label, entryName, entryPath }) => {
        if (injected || label !== "Operational-v2-Publikationsstaging" || entryName !== "operational-infrastructure-v2.json") return;
        injected = true;
        await unlink(entryPath);
        await writeFile(entryPath, "foreign-cleanup-race\n", { flag: "wx" });
      },
    },
  }), /fremd ersetzt|Cleanup|Quarantaene/u);
  assert.equal(injected, true);
  const cleanupRoots = (await readdir(dirname(value.paths.outputPath)))
    .filter((name) => name.startsWith(".operational-v2-owned-cleanup-"));
  let foundForeign = false;
  for (const name of cleanupRoots) {
    const pending = [join(dirname(value.paths.outputPath), name)];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if ((await readFile(path, "utf8")) === "foreign-cleanup-race\n") foundForeign = true;
      }
    }
  }
  assert.equal(foundForeign, true);
});

test("Ausfuehrungsinventar driftet vor jedem importierten Validator-Aufruf fail-closed", async (t) => {
  const value = await fixture(t);
  await capture(value);
  const implementationPath = join(value.paths.root, ...GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES.implementation.split("/"));
  await writeFile(implementationPath, "// pre-validator substitution\n", { flag: "a" });
  let verifierCalls = 0;
  await assert.rejects(publish(value, {
    verifyValidatorRebuildEvidence: async (arguments_) => {
      verifierCalls += 1;
      return fixtureVerifyValidatorRebuildEvidence(arguments_);
    },
  }), /Ausfuehrungsinventar.*driftet|Expected values to be strictly equal/u);
  assert.equal(verifierCalls, 0);
  await assertNoVisiblePair(value.paths);
});

test("anderes Validator-Binary und Implementierungsdrift bleiben vor Publikation fail-closed", async (t) => {
  const wrongValidator = await fixture(t);
  await capture(wrongValidator);
  const otherValidatorPath = join(wrongValidator.paths.root, "tools", "native", "other-validator.exe");
  await writeFile(otherValidatorPath, "other-validator\n", { flag: "wx" });
  await assert.rejects(
    publish(wrongValidator, {
      materialize: async (arguments_) => ({
        ...await fixtureMaterializer(arguments_),
        validatorExecutablePath: otherValidatorPath,
      }),
    }),
    /belegt nicht.*Validator-Binary/u,
  );
  await assertNoVisiblePair(wrongValidator.paths);

  for (const id of ["implementation", "operationalBinding", "validatorRebuildBootstrap", "validatorRebuildVerifier"]) {
    const implementationDrift = await fixture(t);
    await capture(implementationDrift);
    const implementationPath = join(
      implementationDrift.paths.root,
      ...GERMANY_OPERATIONAL_PUBLICATION_EXECUTION_FILES[id].split("/"),
    );
    await assert.rejects(
      publish(implementationDrift, {
        materialize: async (arguments_) => {
          const result = await fixtureMaterializer(arguments_);
          await writeFile(implementationPath, "// injected drift\n", { flag: "a" });
          return result;
        },
      }),
      /Ausfuehrungsinventar.*driftet|Expected values to be strictly equal/u,
      id,
    );
    await assertNoVisiblePair(implementationDrift.paths);
  }
});

test("bestehendes Ziel, stale Sidecar, stale Claim und verwaistes Staging bleiben fail-closed", async (t) => {
  const existing = await fixture(t);
  await capture(existing);
  await writeFile(existing.paths.outputPath, "fremd\n", { flag: "wx" });
  await assert.rejects(publish(existing), /Preflight|blocked-unowned-partial/u);
  assert.equal(await readFile(existing.paths.outputPath, "utf8"), "fremd\n");

  const staleSidecar = await fixture(t);
  await writeFile(staleSidecar.paths.movementRouteTemplatesPath, "stale\n", { flag: "wx" });
  const sidecarInspection = await inspectGermanyOperationalInfrastructureV2Publication({ outputPath: staleSidecar.paths.outputPath, publicationReceiptPath: staleSidecar.paths.publicationReceiptPath });
  assert.equal(sidecarInspection.status, "blocked-unowned-partial");
  await assert.rejects(recoverGermanyOperationalInfrastructureV2Publication({ outputPath: staleSidecar.paths.outputPath, publicationReceiptPath: staleSidecar.paths.publicationReceiptPath }), /darf nicht automatisch/u);

  const staleClaim = await fixture(t);
  await writeFile(join(dirname(staleClaim.paths.outputPath), ".operational-infrastructure-v2.publication-claim.json"), "{}\n", { flag: "wx" });
  assert.equal((await inspectGermanyOperationalInfrastructureV2Publication({ outputPath: staleClaim.paths.outputPath, publicationReceiptPath: staleClaim.paths.publicationReceiptPath })).status, "blocked-invalid-claim");

  const orphan = await fixture(t);
  await mkdir(join(dirname(orphan.paths.outputPath), ".operational-v2-publish-orphan"));
  assert.equal((await inspectGermanyOperationalInfrastructureV2Publication({ outputPath: orphan.paths.outputPath, publicationReceiptPath: orphan.paths.publicationReceiptPath })).status, "blocked-orphan-staging");
});

test("Postlink-Proof- und Receiptfehler rollen Operational zuerst und Sidecar danach owned-only zurueck", async (t) => {
  for (const [name, hooks] of [
    ["proof", { afterOperationalLink: async ({ paths }) => writeFile(paths.output, "drift", { flag: "a" }) }],
    ["receipt-reservation", { afterReceiptReservation: async () => { throw new Error("injected receipt reservation failure"); } }],
    ["receipt-write", { beforeReceiptWrite: async () => { throw new Error("injected receipt write failure"); } }],
    ["receipt-partial-write", { duringReceiptWrite: async () => { throw new Error("injected partial receipt write failure"); } }],
    ["receipt-after-write", { afterReceiptWrite: async () => { throw new Error("injected complete receipt write failure"); } }],
    ["receipt-proof", { afterReceiptLink: async () => { throw new Error("injected receipt proof failure"); } }],
  ]) {
    const value = await fixture(t);
    await capture(value);
    await assert.rejects(publish(value, { hooks }), /driftet|injected/u, name);
    await assertNoVisiblePair(value.paths);
  }
});

test("fremde Ersetzung bleibt bei spaetem Fehler erhalten", async (t) => {
  const value = await fixture(t);
  await capture(value);
  await assert.rejects(publish(value, {
    hooks: {
      afterOperationalLink: async ({ paths }) => {
        await unlink(paths.movementRouteTemplates);
        await writeFile(paths.movementRouteTemplates, "fremdes-sidecar\n", { flag: "wx" });
        throw new Error("injected foreign replacement");
      },
    },
  }), /foreign replacement/u);
  assert.equal(await exists(value.paths.outputPath), false);
  assert.equal(await readFile(value.paths.movementRouteTemplatesPath, "utf8"), "fremdes-sidecar\n");
  assert.equal(await exists(value.paths.publicationReceiptPath), false);

  const reservedReceipt = await fixture(t);
  await capture(reservedReceipt);
  let foreignReservedReceipt;
  await assert.rejects(publish(reservedReceipt, {
    hooks: {
      afterReceiptReservation: async ({ stagedReceipt, receiptHandle }) => {
        await receiptHandle.close();
        await unlink(stagedReceipt);
        await writeFile(stagedReceipt, "foreign-reserved-receipt\n", { flag: "wx" });
        foreignReservedReceipt = stagedReceipt;
      },
    },
  }), /Reserviertes.*fremd ersetzt|Cleanup/u);
  await assertNoVisiblePair(reservedReceipt.paths);
  const cleanupDirectories = (await readdir(dirname(reservedReceipt.paths.outputPath)))
    .filter((name) => name.startsWith(".operational-v2-owned-cleanup-"));
  assert.equal(cleanupDirectories.length, 1);
  assert.equal(
    await readFile(join(dirname(reservedReceipt.paths.outputPath), cleanupDirectories[0], basename(dirname(foreignReservedReceipt)), basename(foreignReservedReceipt)), "utf8"),
    "foreign-reserved-receipt\n",
  );
});

test("Claim-Ersatz nach Staging-Cleanup bleibt trotz Linux-Inode-Reuse fremd", async (t) => {
  const value = await fixture(t);
  await capture(value);
  let replaced = false;
  await assert.rejects(publish(value, {
    hooks: {
      beforeOwnedPathQuarantineRename: async ({ label, original }) => {
        if (replaced || label !== "Operational-v2-Publikationsclaim") return;
        replaced = true;
        await unlink(original);
        await writeFile(original, "foreign-claim-after-staging-cleanup\n", { flag: "wx" });
      },
    },
  }), /Claim.*fremd ersetzt|Cleanup/u);
  assert.equal(replaced, true);
  const claimPath = join(dirname(value.paths.outputPath), ".operational-infrastructure-v2.publication-claim.json");
  assert.equal(await readFile(claimPath, "utf8"), "foreign-claim-after-staging-cleanup\n");
});

test("Claim- und Staging-Ersetzung nach Receipt-Link werden als Cleanupfehler propagiert", async (t) => {
  const replacedClaim = await fixture(t);
  await capture(replacedClaim);
  await assert.rejects(publish(replacedClaim, {
    hooks: {
      afterReceiptLink: async ({ claim }) => {
        await unlink(claim.path);
        await writeFile(claim.path, "foreign-claim\n", { flag: "wx" });
      },
    },
  }), /Claim.*fremd ersetzt|Cleanup/u);
  assert.equal(await readFile(join(dirname(replacedClaim.paths.outputPath), ".operational-infrastructure-v2.publication-claim.json"), "utf8"), "foreign-claim\n");
  assert.equal(await exists(replacedClaim.paths.publicationReceiptPath), true);

  const replacedStaging = await fixture(t);
  await capture(replacedStaging);
  let foreignStaging;
  await assert.rejects(publish(replacedStaging, {
    hooks: {
      afterReceiptLink: async ({ staging }) => {
        const ownedMoved = `${staging}-owned-moved`;
        await rename(staging, ownedMoved);
        await mkdir(staging);
        foreignStaging = staging;
      },
    },
  }), /Staging.*fremd ersetzt|Cleanup/u);
  assert.equal(await exists(foreignStaging), true);
  assert.equal(await exists(join(dirname(replacedStaging.paths.outputPath), ".operational-infrastructure-v2.publication-claim.json")), true);
  assert.equal(await exists(replacedStaging.paths.publicationReceiptPath), true);

  const replacedStagingFile = await fixture(t);
  await capture(replacedStagingFile);
  let replacedFile;
  await assert.rejects(publish(replacedStagingFile, {
    hooks: {
      afterReceiptLink: async ({ staging }) => {
        replacedFile = join(staging, "operational-infrastructure-v2.json");
        await unlink(replacedFile);
        await writeFile(replacedFile, "foreign-staged-operational\n", { flag: "wx" });
      },
    },
  }), /Staging.*operational-infrastructure-v2\.json.*fremd ersetzt|Cleanup/u);
  assert.equal(await exists(join(dirname(replacedStagingFile.paths.outputPath), ".operational-infrastructure-v2.publication-claim.json")), true);
  const cleanupDirectories = (await readdir(dirname(replacedStagingFile.paths.outputPath)))
    .filter((name) => name.startsWith(".operational-v2-owned-cleanup-"));
  assert.equal(cleanupDirectories.length, 1);
  assert.equal(
    await readFile(join(dirname(replacedStagingFile.paths.outputPath), cleanupDirectories[0], basename(dirname(replacedFile)), basename(replacedFile)), "utf8"),
    "foreign-staged-operational\n",
  );
});

test("Symlink-/Junction-Elternpfad und Parent-Swap werden vor weiterer Mutation abgewiesen", async (t) => {
  const linked = await fixture(t);
  await capture(linked);
  const realRelease = dirname(linked.paths.outputPath);
  const alias = join(linked.paths.root, "release-alias");
  await symlink(realRelease, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(publishGermanyOperationalInfrastructureV2FromNativeReceipt({
    specificationPath: linked.paths.specificationPath,
    candidatePath: linked.paths.candidatePath,
    candidateMovementRouteTemplatesPath: linked.paths.candidateMovementRouteTemplatesPath,
    reportPath: linked.paths.reportPath,
    nativeReceiptPath: linked.paths.nativeReceiptPath,
    validatorRebuildSpecificationPath: linked.paths.validatorRebuildSpecificationPath,
    validatorRebuildEvidencePath: linked.paths.validatorRebuildEvidencePath,
    outputPath: join(alias, basename(linked.paths.outputPath)),
    publicationReceiptPath: join(alias, basename(linked.paths.publicationReceiptPath)),
    workspaceRoot: linked.paths.root,
    publisherEntrypointPath: linked.paths.publisherEntrypointPath,
    materialize: fixtureMaterializer,
    verifyValidatorRebuildEvidence: fixtureVerifyValidatorRebuildEvidence,
  }), /Symlink|Junction|regulaeres Verzeichnis/u);

  const swapped = await fixture(t);
  await capture(swapped);
  const parent = dirname(swapped.paths.outputPath);
  const moved = `${parent}-moved`;
  await assert.rejects(publish(swapped, {
    hooks: {
      beforeReceiptLink: async () => {
        await rename(parent, moved);
        await mkdir(parent);
      },
    },
  }), /ausgetauscht|Identitaet|EPERM|operation not permitted/u);
  if (await exists(moved)) {
    assert.deepEqual(await readdir(parent), []);
    assert.equal(await exists(join(moved, basename(swapped.paths.movementRouteTemplatesPath))), true);
  } else {
    // Windows denies replacing a directory that still contains held target
    // handles; that kernel-level denial is itself the required fail-closed
    // result, and the original parent remains pinned.
    assert.equal(await exists(parent), true);
    await assertNoVisiblePair(swapped.paths);
  }
});

test("Killpoint zwischen den Links hinterlaesst typisiert recoverable-partial und Recovery bereinigt owned-only", async (t) => {
  const value = await fixture(t);
  await capture(value);
  const killed = await spawnPublisherKillpoint(value, "afterSidecarLink");
  assert.equal(killed.status, 73, `${killed.stderr}\n${killed.stdout}`);
  const inspection = await inspectGermanyOperationalInfrastructureV2Publication({ outputPath: value.paths.outputPath, publicationReceiptPath: value.paths.publicationReceiptPath });
  assert.equal(inspection.status, "recoverable-partial");
  assert.deepEqual(inspection.existing, ["movementRouteTemplates"]);
  const recovered = await recoverGermanyOperationalInfrastructureV2Publication({ outputPath: value.paths.outputPath, publicationReceiptPath: value.paths.publicationReceiptPath });
  assert.equal(recovered.status, "clean");
  await assertNoVisiblePair(value.paths);
});

test("Killpoints vor, mitten und nach Receipt-Write bleiben mit reservierter Receipt-Datei recoverable", async (t) => {
  for (const [hookName, expectedReceiptSize] of [
    ["beforeReceiptWrite", 0],
    ["duringReceiptWrite", 1],
    ["afterReceiptWrite", 1],
  ]) {
    const value = await fixture(t);
    await capture(value);
    const killed = await spawnPublisherKillpoint(value, hookName, 74);
    assert.equal(killed.status, 74, `${hookName}: ${killed.stderr}\n${killed.stdout}`);
    const inspection = await inspectGermanyOperationalInfrastructureV2Publication({
      outputPath: value.paths.outputPath,
      publicationReceiptPath: value.paths.publicationReceiptPath,
    });
    assert.equal(inspection.status, "recoverable-partial", hookName);
    const stagedReceipt = join(inspection.staging, basename(value.paths.publicationReceiptPath));
    const receiptBytes = (await readFile(stagedReceipt)).length;
    if (expectedReceiptSize === 0) assert.equal(receiptBytes, 0, hookName);
    else assert.ok(receiptBytes > 0, hookName);
    const recovered = await recoverGermanyOperationalInfrastructureV2Publication({
      outputPath: value.paths.outputPath,
      publicationReceiptPath: value.paths.publicationReceiptPath,
    });
    assert.equal(recovered.status, "clean", hookName);
    await assertNoVisiblePair(value.paths);
  }
});

test("Crash-Recovery uebernimmt kein fremd ersetztes reserviertes Receipt", async (t) => {
  const value = await fixture(t);
  await capture(value);
  const killed = await spawnPublisherKillpoint(value, "duringReceiptWrite", 76);
  assert.equal(killed.status, 76, `${killed.stderr}\n${killed.stdout}`);
  const beforeReplacement = await inspectGermanyOperationalInfrastructureV2Publication({
    outputPath: value.paths.outputPath,
    publicationReceiptPath: value.paths.publicationReceiptPath,
  });
  assert.equal(beforeReplacement.status, "recoverable-partial");
  const stagedReceipt = join(beforeReplacement.staging, basename(value.paths.publicationReceiptPath));
  const receiptAnchor = join(beforeReplacement.staging, `.${basename(value.paths.publicationReceiptPath)}.ownership-anchor`);
  assert.equal(await exists(receiptAnchor), true);
  await unlink(stagedReceipt);
  await writeFile(stagedReceipt, "foreign-crash-recovery-receipt\n", { flag: "wx" });

  const afterReplacement = await inspectGermanyOperationalInfrastructureV2Publication({
    outputPath: value.paths.outputPath,
    publicationReceiptPath: value.paths.publicationReceiptPath,
  });
  assert.equal(afterReplacement.status, "blocked-replaced-staging-file");
  await assert.rejects(recoverGermanyOperationalInfrastructureV2Publication({
    outputPath: value.paths.outputPath,
    publicationReceiptPath: value.paths.publicationReceiptPath,
  }), /darf nicht automatisch/u);
  assert.equal(await readFile(stagedReceipt, "utf8"), "foreign-crash-recovery-receipt\n");
  assert.equal(await exists(receiptAnchor), true);
  assert.equal(await exists(join(dirname(value.paths.outputPath), ".operational-infrastructure-v2.publication-claim.json")), true);
});

test("Recovery behaelt Claim und fremdes Staging bei Race nach Target-Rollback", async (t) => {
  const value = await fixture(t);
  await capture(value);
  const killed = await spawnPublisherKillpoint(value, "afterSidecarLink", 75);
  assert.equal(killed.status, 75, `${killed.stderr}\n${killed.stdout}`);
  const claimPath = join(dirname(value.paths.outputPath), ".operational-infrastructure-v2.publication-claim.json");
  let foreignStaging;
  await assert.rejects(recoverGermanyOperationalInfrastructureV2Publication({
    outputPath: value.paths.outputPath,
    publicationReceiptPath: value.paths.publicationReceiptPath,
    hooks: {
      beforeRecoveryStagingCleanup: async ({ staging }) => {
        await rename(staging, `${staging}-owned-moved`);
        await mkdir(staging);
        foreignStaging = staging;
        await writeFile(join(staging, "foreign.txt"), "foreign-recovery-staging\n", { flag: "wx" });
      },
    },
  }), /Recovery-Staging.*fremd ersetzt/u);
  assert.equal(await exists(claimPath), true);
  assert.equal(await readFile(join(foreignStaging, "foreign.txt"), "utf8"), "foreign-recovery-staging\n");
  assert.equal(await exists(value.paths.movementRouteTemplatesPath), false);
});

test("grosses Sidecar bleibt im Publisher streamend und unter 512 MiB RSS messbar", { timeout: 180_000 }, async (t) => {
  const value = await fixture(t, { sidecarBytes: 128 * 1024 * 1024 });
  await capture(value);
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
  try {
    await publish(value, { hooks: { onStreamingChunk: ({ rss }) => { peakRss = Math.max(peakRss, rss); } } });
  } finally {
    clearInterval(sampler);
  }
  assert.ok(peakRss < 512 * 1024 * 1024, `Publisher RSS ${peakRss} muss unter 512 MiB bleiben`);
  assert.equal((await readFile(value.paths.publicationReceiptPath, "utf8")).includes(GERMANY_OPERATIONAL_PUBLICATION_RECEIPT_SCHEMA), true);
});
