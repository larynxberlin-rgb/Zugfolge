import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessGermanyOperationalInfrastructureV2Readiness,
  deriveGermanyOperationalInfrastructureV2,
  GERMANY_OPERATIONAL_CONSERVATIVE_MODE,
  GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID,
  GERMANY_OPERATIONAL_CONSERVATIVE_SCHEMA,
  GERMANY_OPERATIONAL_COMPLETE_ROUTE_COVERAGE,
  GERMANY_OPERATIONAL_DERIVATION_MODE,
  GERMANY_OPERATIONAL_DERIVATION_SCHEMA,
  GERMANY_OPERATIONAL_NATIVE_RECEIPT_SCHEMA,
  GERMANY_OPERATIONAL_NATIVE_REPORT_SCHEMA,
  GERMANY_OPERATIONAL_NATIVE_EXECUTABLE_ENV,
  GERMANY_OPERATIONAL_REQUIRED_INPUTS,
  OperationalInfrastructureDerivationBlockedError,
  OperationalInfrastructureDerivationIncompleteError,
  runGermanyOperationalInfrastructureV2,
  spawnGermanyOperationalInfrastructureV2Compiler,
  validateGermanyOperationalInfrastructureV2Specification,
} from "./operational-infrastructure-v2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "run-operational-infrastructure-v2.mjs");
const CHECKED_IN_SPEC = join(HERE, "operational-infrastructure.annual-2026.3.json");
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

function mapLayers() {
  return {
    tracks: "var/derived/germany-2026.3/final-map-layers-v2/tracks.geojsonseq",
    platforms: "var/derived/germany-2026.3/final-map-layers-v2/platforms.geojsonseq",
    switches: "var/derived/germany-2026.3/final-map-layers-v2/switches.geojsonseq",
    signals: "var/derived/germany-2026.3/final-map-layers-v2/signals.geojsonseq",
    blocks: "var/derived/germany-2026.3/final-map-layers-v2/blocks.geojsonseq",
    conflictResources: "var/derived/germany-2026.3/final-map-layers-v2/conflict-resources.geojsonseq",
  };
}

function conservativeSpecification(timetableRoutes = "var/derived/germany-2026.3/timetable-routes-v2.jsonseq") {
  return {
    schema: GERMANY_OPERATIONAL_CONSERVATIVE_SCHEMA,
    mode: GERMANY_OPERATIONAL_CONSERVATIVE_MODE,
    infraReleaseId: RELEASE_ID,
    layers: { ...mapLayers(), timetableRoutes, transferDemands: null },
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
      turnaroundPairCount: 0,
    },
  };
  return { ...value, stateHash: canonicalHash({ schema: "movement-route-templates-v2", value }) };
}

function movementSidecarBytes() {
  return Buffer.from(`${JSON.stringify(movementSidecar())}\n`, "utf8");
}

function movementSidecarProof() {
  const bytes = movementSidecarBytes();
  return {
    file: "operational-infrastructure-v2.movement-route-templates-v2.json",
    bytes: bytes.length,
    sha256: sha256(bytes),
    stateHash: movementSidecar().stateHash,
    operationalStateHash: STATE_HASH,
    timetableTransferSetSha256: null,
  };
}

function readinessSpecification() {
  return {
    schema: GERMANY_OPERATIONAL_DERIVATION_SCHEMA,
    mode: GERMANY_OPERATIONAL_DERIVATION_MODE,
    infraReleaseId: RELEASE_ID,
    layers: mapLayers(),
    operationalInputs: Object.fromEntries(GERMANY_OPERATIONAL_REQUIRED_INPUTS.map(({ name }) => [name, null])),
  };
}

function candidate() {
  return {
    id: RELEASE_ID,
    directedEdges: { "edge-1": 1_000 },
    edgeGeometries: {
      "edge-1": [
        { edgeOffsetMm: 0, latitudeE7: 510_000_000, longitudeE7: 120_000_000, bearingMilliDegrees: 90_000 },
        { edgeOffsetMm: 1_000, latitudeE7: 510_000_000, longitudeE7: 120_001_000, bearingMilliDegrees: null },
      ],
    },
    routeVersions: {
      "route-1": {
        id: "route-1",
        templateId: "template-1",
        predecessorId: null,
        transitionRouteMm: null,
        legs: [{ edgeId: "edge-1", direction: "along", edgeEntryMm: 0, edgeExitMm: 1_000, routeStartMm: 0, blockIds: ["block-1"], speedLimitMmps: 20_000, gradientPerMille: 0, availableProtectionSystems: ["pzb"], simultaneouslyRequiredProtectionSystems: [] }],
      },
    },
    interlockingRoutes: {
      "interlocking-1": {
        id: "interlocking-1",
        routeTemplateId: "template-1",
        signalId: "signal-1",
        movementKind: "train",
        pathResources: ["block-1"],
        overlapResources: ["overlap-1"],
        flankResources: ["flank-1"],
        switchPositions: {},
        authorityStartRouteMm: 0,
        authorityEndRouteMm: 1_000,
        releaseAfterTailRouteMm: 1_000,
      },
    },
    signals: ["signal-1"],
    switches: [],
    blockResources: ["block-1", "flank-1", "overlap-1"],
    platformIntervals: {},
    regionBoundaries: ["region:deutschland-ebo"],
    rzueLayoutId: "rzue-deutschland-2026.3-synthetic-b-v2",
  };
}

function derivationReport(specification, { activationEligible = true, mutate = (value) => value } = {}) {
  const unresolvedRequiredDimensions = activationEligible ? [] : ["complete-timetable-route-versions"];
  const routeCoverage = activationEligible ? GERMANY_OPERATIONAL_COMPLETE_ROUTE_COVERAGE : "local-directed-track-templates";
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate())}\n`, "utf8");
  const evidence = (path) => ({ path, bytes: 1, sha256: "2".repeat(64), records: 1 });
  return mutate({
    schema: GERMANY_OPERATIONAL_NATIVE_REPORT_SCHEMA,
    mode: GERMANY_OPERATIONAL_CONSERVATIVE_MODE,
    infraReleaseId: RELEASE_ID,
    policy: { id: specification.policy.id, sha256: canonicalHash(specification.policy), spec: specification.policy },
    inputs: {
      spec: evidence("specification.json"),
      tracks: evidence(specification.layers.tracks),
      platforms: evidence(specification.layers.platforms),
      switches: evidence(specification.layers.switches),
      signals: evidence(specification.layers.signals),
      blocks: evidence(specification.layers.blocks),
      conflictResources: evidence(specification.layers.conflictResources),
      timetableRoutes: specification.layers.timetableRoutes === null ? null : evidence(specification.layers.timetableRoutes),
      transferDemands: null,
    },
    candidate: { bytes: candidateBytes.length, sha256: sha256(candidateBytes), stateHash: STATE_HASH, validationMode: "native-streaming-redb-v1", movementRouteTemplates: movementSidecarProof() },
    timetableRouteEvidence: null,
    counts: {
      source: { tracks: 1, orderableTracks: 1, platforms: 0, switches: 0, signals: 0, blocks: 0, conflictResources: 0, timetableRoutes: activationEligible ? 1 : 0, timetableLegs: activationEligible ? 1 : 0, transferDemands: 0, transferLots: 0, turnaroundDemands: 0, turnaroundPairs: 0 },
      candidate: { directedEdges: 1, edgeGeometries: 1, routeVersions: 1, interlockingRoutes: 1, signals: 1, switches: 0, blockResources: 3, platformIntervals: 0, regionBoundaries: 1, directTemplates: 0, stablingTemplates: 0, transferTemplates: 0 },
      provenance: { observedForwardSpeeds: 1, observedBackwardSpeeds: 1, simulatedSpeeds: 0, observedProtectionAssignments: 1, simulatedProtectionAssignments: 0, matchedPlatformIntervals: 0, excludedPlatformEvidence: 0, syntheticBoundarySignals: 1, turnaroundRouteVersions: 0, turnaroundInterlockingRoutes: 0, transferRouteVersions: 0, transferInterlockingRoutes: 0 },
    },
    scope: { routeModel: routeCoverage, interlockingModel: "deterministic-linear-segment-node-stellzone-mutex-and-progressive-authority/v3", platformModel: "deterministic-nearest-observed-track-within-policy-radius/v1", capacityBias: "conservative-under-capacity", minimumOverlapMmPolicy: specification.policy.minimumOverlapMm, turnaroundModel: "real-osm-simple-bidirectional-siding-path-with-centered-single-berth-per-target-edge/v1", minimumBerthEndClearanceMmPolicy: specification.policy.minimumBerthEndClearanceMm, maximumDirectDwellMsPolicy: specification.policy.maximumDirectDwellMs, terminalFormationLengthsMm: specification.policy.terminalFormationLengthsMm, movementRouteTemplateModel: "daily-plan-scoped-direct-stabling-transfer-continuity/v2" },
    routeCoverage,
    activationEligible,
    unresolvedRequired: unresolvedRequiredDimensions.length,
    unresolvedRequiredDimensions,
    realInterlockingFactsClaimed: false,
    realGeometry: true,
    simulatedOperationalAssignment: true,
    candidateProduced: true,
  });
}

function fixtureNativeCompiler(specification, options = {}) {
  return async (_specificationPath, _sourceRoot, candidatePath, reportPath) => {
    const candidateBytes = Buffer.from(`${JSON.stringify(candidate())}\n`, "utf8");
    const sidecarBytes = movementSidecarBytes();
    const reportBytes = Buffer.from(`${JSON.stringify(derivationReport(specification, options))}\n`, "utf8");
    await writeFile(candidatePath, candidateBytes, { flag: "wx" });
    await writeFile(join(dirname(candidatePath), "operational-infrastructure-v2.movement-route-templates-v2.json"), sidecarBytes, { flag: "wx" });
    await writeFile(reportPath, reportBytes, { flag: "wx" });
    const receipt = {
      schema: GERMANY_OPERATIONAL_NATIVE_RECEIPT_SCHEMA,
      infraReleaseId: RELEASE_ID,
      candidate: { bytes: candidateBytes.length, sha256: sha256(candidateBytes), stateHash: STATE_HASH },
      movementRouteTemplates: movementSidecarProof(),
      report: { bytes: reportBytes.length, sha256: sha256(reportBytes) },
      candidateProduced: true,
      activationEligible: options.activationEligible ?? true,
      unresolvedRequired: options.activationEligible === false ? 1 : 0,
    };
    return options.mutateReceipt === undefined ? receipt : options.mutateReceipt(receipt);
  };
}

async function fixtureMaterializer({ candidatePath, expectedReleaseId, outputPath }) {
  const source = await readFile(candidatePath);
  assert.equal(JSON.parse(source).id, expectedReleaseId);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, { flag: "wx" });
  return {
    sourceBytes: source.length,
    sourceSha256: sha256(source),
    bytes: source.length,
    sha256: sha256(source),
    stateHash: STATE_HASH,
  };
}

function outputPaths(root) {
  return {
    candidatePath: join(root, "candidate.json"),
    reportPath: join(root, "report.json"),
    outputPath: join(root, "release", "operational-infrastructure-v2.json"),
    movementRouteTemplatesPath: join(root, "release", "operational-infrastructure-v2.movement-route-templates-v2.json"),
  };
}

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

async function writeJsonSequence(path, records) {
  const chunks = records.map((record) => `\u001e${JSON.stringify(record)}\n`);
  await writeFile(path, chunks.join(""), "utf8");
}

function feature(geometry, properties) {
  return { type: "Feature", geometry, properties };
}

test("die eingecheckte Jahres-Spezifikation bindet den konservativen Klasse-B-Vertrag und alle 2026.3-Eingaben", async () => {
  const specification = JSON.parse(await readFile(CHECKED_IN_SPEC, "utf8"));
  assert.equal(validateGermanyOperationalInfrastructureV2Specification(specification), "conservative");
  assert.deepEqual(specification, conservativeSpecification());
  assert.equal(Object.values(specification.layers).filter((value) => typeof value === "string").every((value) => value.includes("germany-2026.3")), true);
  assert.equal(specification.policy.id, GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID);
  assert.equal(specification.policy.qualityClass, "B");
});

test("der konservative Vertrag ist exact-key-, Pfad- und Policy-strikt", () => {
  const extra = conservativeSpecification();
  extra.unbelegt = true;
  assert.throws(() => validateGermanyOperationalInfrastructureV2Specification(extra), /unbekannte oder fehlende Felder/u);

  const traversal = conservativeSpecification();
  traversal.layers.timetableRoutes = "../fremd.jsonseq";
  assert.throws(() => validateGermanyOperationalInfrastructureV2Specification(traversal), /normalisierter Pfad/u);

  const absolute = conservativeSpecification();
  absolute.layers.tracks = "C:\\fremd\\tracks.jsonseq";
  assert.throws(() => validateGermanyOperationalInfrastructureV2Specification(absolute), /relativer Artefaktpfad/u);

  const wrongPolicy = conservativeSpecification();
  wrongPolicy.policy.id = "synthetic-operational-b/latest";
  assert.throws(() => validateGermanyOperationalInfrastructureV2Specification(wrongPolicy), /policy.id muss/u);

  const unsafeSpeed = conservativeSpecification();
  unsafeSpeed.policy.unknownServiceSpeedKmh = 30;
  assert.throws(() => validateGermanyOperationalInfrastructureV2Specification(unsafeSpeed), /darf die unbekannte Hauptgleisgeschwindigkeit nicht uebersteigen/u);

  const missingRouteLayer = conservativeSpecification();
  delete missingRouteLayer.layers.timetableRoutes;
  assert.throws(() => validateGermanyOperationalInfrastructureV2Specification(missingRouteLayer), /unbekannte oder fehlende Felder/u);
});

test("der Readiness- und alte Sechs-Layer-Vertrag bleiben Status-2-fail-closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const specPath = join(root, "readiness.json");
  const paths = outputPaths(root);
  const specification = readinessSpecification();
  await writeFile(specPath, `${JSON.stringify(specification)}\n`, "utf8");
  const result = spawnSync(process.execPath, [RUNNER, specPath, root, paths.candidatePath, paths.reportPath], { encoding: "utf8" });
  assert.equal(result.status, 2, `${result.stderr}\n${result.stdout}`);
  await assertMissing(paths.candidatePath);
  await assertMissing(paths.outputPath);
  const report = JSON.parse(await readFile(paths.reportPath, "utf8"));
  assert.deepEqual(report, assessGermanyOperationalInfrastructureV2Readiness(specification));
  assert.equal(report.candidateProduced, false);
  assert.equal(report.unresolvedRequired, 10);

  const legacy = { schema: "zugfolge-germany-operational-infrastructure-derivation/v1", infraReleaseId: RELEASE_ID, layers: mapLayers(), policy: { forbidden: true } };
  await assert.rejects(
    deriveGermanyOperationalInfrastructureV2(legacy, "."),
    (error) => error instanceof OperationalInfrastructureDerivationBlockedError
      && error.report.blockers.some(({ code }) => code === "legacy-six-layer-derivation-schema-forbidden"),
  );
});

test("der neue Runner verlangt sein fuenftes OUTPUT-Argument, Legacy verbietet es", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-runner-args-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = outputPaths(root);
  const conservativePath = join(root, "conservative.json");
  await writeFile(conservativePath, JSON.stringify(conservativeSpecification()));
  const missingOutput = spawnSync(process.execPath, [RUNNER, conservativePath, root, paths.candidatePath, paths.reportPath], { encoding: "utf8" });
  assert.notEqual(missingOutput.status, 0);
  assert.match(missingOutput.stderr, /fuenfte Argument OUTPUT/u);
  await assertMissing(paths.candidatePath);
  await assertMissing(paths.reportPath);

  const readinessPath = join(root, "readiness.json");
  await writeFile(readinessPath, JSON.stringify(readinessSpecification()));
  const legacyWithOutput = spawnSync(process.execPath, [RUNNER, readinessPath, root, paths.candidatePath, paths.reportPath, paths.outputPath], { encoding: "utf8" });
  assert.notEqual(legacyWithOutput.status, 0);
  assert.match(legacyWithOutput.stderr, /exakt vier Argumente/u);
  await assertMissing(paths.outputPath);
});

test("publiziert einen nativen vollständigen Candidate erst nach Berichtsgate und Materialisierung", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-conservative-positive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const specification = conservativeSpecification();
  const specificationPath = join(root, "specification.json");
  await writeFile(specificationPath, JSON.stringify(specification));
  const paths = outputPaths(root);
  const receipt = await runGermanyOperationalInfrastructureV2({
    specification,
    specificationPath,
    sourceRoot: root,
    ...paths,
    deriveNative: fixtureNativeCompiler(specification),
    materialize: fixtureMaterializer,
  });
  assert.equal(receipt.candidateProduced, true);
  assert.deepEqual(receipt.reportStatus, { unresolvedRequired: 0, activationEligible: true, realInterlockingFactsClaimed: false });
  assert.equal(receipt.materialized.stateHash, STATE_HASH);
  assert.deepEqual(JSON.parse(await readFile(paths.candidatePath, "utf8")), candidate());
  assert.deepEqual(JSON.parse(await readFile(paths.reportPath, "utf8")), derivationReport(specification));
  assert.deepEqual(JSON.parse(await readFile(paths.outputPath, "utf8")), candidate());
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".operational-v2-derive-")), []);
});

test("lokale Track-Vorlagen bleiben eine Strukturdiagnose: Candidate und Bericht ja, OUTPUT nein", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-conservative-incomplete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const specification = conservativeSpecification(null);
  const specificationPath = join(root, "specification.json");
  await writeFile(specificationPath, JSON.stringify(specification));
  const paths = outputPaths(root);
  let materialized = false;
  await assert.rejects(
    runGermanyOperationalInfrastructureV2({
      specification,
      specificationPath,
      sourceRoot: root,
      ...paths,
      deriveNative: fixtureNativeCompiler(specification, { activationEligible: false }),
      materialize: async () => { materialized = true; },
    }),
    (error) => error instanceof OperationalInfrastructureDerivationIncompleteError
      && error.result.nativeReport.unresolvedRequiredDimensions[0] === "complete-timetable-route-versions",
  );
  assert.equal(materialized, false);
  assert.deepEqual(JSON.parse(await readFile(paths.candidatePath, "utf8")), candidate());
  assert.equal(JSON.parse(await readFile(paths.reportPath, "utf8")).activationEligible, false);
  await assertMissing(paths.outputPath);
});

test("manipulierte Receipts und widerspruechliche native Reports veroeffentlichen gar nichts", async (t) => {
  const cases = [
    {
      label: "receipt",
      options: { mutateReceipt: (receipt) => ({ ...receipt, candidate: { ...receipt.candidate, sha256: "0".repeat(64) } }) },
      error: /Candidate-Bindung stimmt nicht/u,
    },
    {
      label: "unresolved-green",
      options: { mutate: (report) => ({ ...report, activationEligible: true, unresolvedRequired: 1, unresolvedRequiredDimensions: ["complete-timetable-route-versions"] }) },
      error: /widerspruechliche Aktivierungsentscheidung/u,
    },
    {
      label: "real-facts",
      options: { mutate: (report) => ({ ...report, realInterlockingFactsClaimed: true }) },
      error: /keine realen Stellwerksfakten/u,
    },
  ];
  for (const { label, options, error } of cases) {
    const root = await mkdtemp(join(tmpdir(), `zugfolge-operational-negative-${label}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const specification = conservativeSpecification();
    const specificationPath = join(root, "specification.json");
    await writeFile(specificationPath, JSON.stringify(specification));
    const paths = outputPaths(root);
    await assert.rejects(
      runGermanyOperationalInfrastructureV2({ specification, specificationPath, sourceRoot: root, ...paths, deriveNative: fixtureNativeCompiler(specification, options), materialize: fixtureMaterializer }),
      error,
    );
    await assertMissing(paths.candidatePath);
    await assertMissing(paths.reportPath);
    await assertMissing(paths.outputPath);
  }
});

test("eine Materialisierungs- oder Zielkollision laesst bestehende Dateien unveraendert", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const specification = conservativeSpecification();
  const specificationPath = join(root, "specification.json");
  await writeFile(specificationPath, JSON.stringify(specification));
  const paths = outputPaths(root);
  await writeFile(paths.reportPath, "unveraendert\n");
  await assert.rejects(
    runGermanyOperationalInfrastructureV2({ specification, specificationPath, sourceRoot: root, ...paths, deriveNative: fixtureNativeCompiler(specification), materialize: fixtureMaterializer }),
    /existiert bereits/u,
  );
  assert.equal(await readFile(paths.reportPath, "utf8"), "unveraendert\n");
  await assertMissing(paths.candidatePath);
  await assertMissing(paths.outputPath);

  await rm(paths.reportPath);
  await assert.rejects(
    runGermanyOperationalInfrastructureV2({
      specification,
      specificationPath,
      sourceRoot: root,
      ...paths,
      deriveNative: fixtureNativeCompiler(specification),
      materialize: async () => { throw new Error("native Gegenpruefung rot"); },
    }),
    /native Gegenpruefung rot/u,
  );
  await assertMissing(paths.candidatePath);
  await assertMissing(paths.reportPath);
  await assertMissing(paths.outputPath);
});

test("der Native-Compiler ist als echter Prozessvertrag spawnbar", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-spawn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, "native-fixture.mjs");
  await writeFile(fixture, `
    import { createHash } from "node:crypto";
    import { writeFileSync } from "node:fs";
    const [command, spec, sourceRoot, candidate, report] = process.argv.slice(2);
    if (command !== "derive-germany-operational-v2" || !spec || !sourceRoot) process.exit(7);
    const candidateBytes = Buffer.from("candidate\\n");
    const reportBytes = Buffer.from("report\\n");
    writeFileSync(candidate, candidateBytes, { flag: "wx" });
    writeFileSync(report, reportBytes, { flag: "wx" });
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    process.stdout.write(JSON.stringify({schema:"${GERMANY_OPERATIONAL_NATIVE_RECEIPT_SCHEMA}",infraReleaseId:"${RELEASE_ID}",candidate:{bytes:candidateBytes.length,sha256:hash(candidateBytes),stateHash:"${STATE_HASH}"},report:{bytes:reportBytes.length,sha256:hash(reportBytes)},candidateProduced:true,activationEligible:true,unresolvedRequired:0}) + "\\n");
  `);
  const previousExecutable = process.env[GERMANY_OPERATIONAL_NATIVE_EXECUTABLE_ENV];
  process.env[GERMANY_OPERATIONAL_NATIVE_EXECUTABLE_ENV] = process.execPath;
  t.after(() => {
    if (previousExecutable === undefined) delete process.env[GERMANY_OPERATIONAL_NATIVE_EXECUTABLE_ENV];
    else process.env[GERMANY_OPERATIONAL_NATIVE_EXECUTABLE_ENV] = previousExecutable;
  });
  const receipt = spawnGermanyOperationalInfrastructureV2Compiler(
    join(root, "spec.json"),
    root,
    join(root, "candidate.json"),
    join(root, "report.json"),
    { argumentPrefix: [fixture], cwd: root },
  );
  assert.equal(receipt.schema, GERMANY_OPERATIONAL_NATIVE_RECEIPT_SCHEMA);
  assert.equal(receipt.candidateProduced, true);
});

test("Node, echter Rust-Ableiter und nativer Materialisierer stimmen Ende-zu-Ende ueberein", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-native-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const track = (id, from, to, lengthMm, left, right) => feature(
    { type: "LineString", coordinates: [left, right] },
    {
      feature_id: id,
      feature_type: "track",
      from_osm_node_id: from,
      to_osm_node_id: to,
      length_mm: lengthMm,
      orderable: true,
      quality_class: "B",
      model_state: "observed_osm_topology_with_conservative_defaults",
      source_id: "test-osm-source",
      osm_way_id: from,
      speed_forward_kmh: 80,
      speed_backward_kmh: 70,
      osm_tags_json: JSON.stringify({ railway: "rail", "railway:pzb": "yes", usage: "main" }),
    },
  );
  await Promise.all([
    writeJsonSequence(join(root, "tracks.geojsonseq"), [
      track("track-1", 1, 2, 1_000, [12, 51], [12.0001, 51]),
      track("track-2", 2, 3, 1_200, [12.0001, 51], [12.0002, 51]),
    ]),
    writeJsonSequence(join(root, "platforms.geojsonseq"), [feature({ type: "Point", coordinates: [12.00005, 51] }, { feature_id: "platform-1", feature_type: "platform" })]),
    writeJsonSequence(join(root, "switches.geojsonseq"), [feature({ type: "Point", coordinates: [12.0001, 51] }, {
      feature_id: "switch-2",
      feature_type: "switch",
      osm_node_id: 2,
      incident_track_ids_json: JSON.stringify(["track-1", "track-2"]),
    })]),
    writeJsonSequence(join(root, "signals.geojsonseq"), [feature({ type: "Point", coordinates: [12, 51] }, {
      feature_id: "signal-observed-1",
      feature_type: "signal",
      incident_track_ids_json: JSON.stringify(["track-1"]),
    })]),
    writeJsonSequence(join(root, "blocks.geojsonseq"), [
      feature({ type: "LineString", coordinates: [[12, 51], [12.0001, 51]] }, {
        feature_id: "block-1",
        track_ids_json: JSON.stringify(["track-1"]),
        boundary_signal_ids_json: JSON.stringify(["signal-observed-1"]),
      }),
      feature({ type: "LineString", coordinates: [[12.0001, 51], [12.0002, 51]] }, {
        feature_id: "block-2",
        track_ids_json: JSON.stringify(["track-2"]),
        boundary_signal_ids_json: JSON.stringify([]),
      }),
    ]),
    writeJsonSequence(join(root, "conflict-resources.geojsonseq"), [
      feature({ type: "LineString", coordinates: [[12, 51], [12.0001, 51]] }, {
        feature_id: "resource-observed-1",
        resource_kind: "block",
        block_id: "block-1",
        track_ids_json: JSON.stringify(["track-1"]),
      }),
      feature({ type: "LineString", coordinates: [[12.0001, 51], [12.0002, 51]] }, {
        feature_id: "resource-observed-2",
        resource_kind: "block",
        block_id: "block-2",
        track_ids_json: JSON.stringify(["track-2"]),
      }),
    ]),
    writeJsonSequence(join(root, "timetable-routes.geojsonseq"), [{
      routeVersionId: "route-version-full-1",
      templateId: "route-template-full-1",
      predecessorId: null,
      transitionRouteMm: null,
      legs: [
        {
          edgeId: "track-1",
          direction: "along",
          edgeEntryMm: 0,
          edgeExitMm: 1_000,
          availableProtectionSystems: ["pzb"],
          simultaneouslyRequiredProtectionSystems: [],
        },
        {
          edgeId: "track-2",
          direction: "along",
          edgeEntryMm: 0,
          edgeExitMm: 1_200,
          availableProtectionSystems: ["pzb"],
          simultaneouslyRequiredProtectionSystems: [],
        },
      ],
    }]),
  ]);
  const specification = conservativeSpecification("timetable-routes.geojsonseq");
  specification.layers = {
    tracks: "tracks.geojsonseq",
    platforms: "platforms.geojsonseq",
    switches: "switches.geojsonseq",
    signals: "signals.geojsonseq",
    blocks: "blocks.geojsonseq",
    conflictResources: "conflict-resources.geojsonseq",
    timetableRoutes: "timetable-routes.geojsonseq",
    transferDemands: null,
  };
  const specificationPath = join(root, "specification.json");
  await writeFile(specificationPath, `${JSON.stringify(specification)}\n`, "utf8");
  const paths = outputPaths(root);
  const receipt = await runGermanyOperationalInfrastructureV2({ specification, specificationPath, sourceRoot: root, ...paths });
  assert.equal(receipt.reportStatus.activationEligible, true);
  assert.equal(receipt.reportStatus.unresolvedRequired, 0);
  assert.equal(receipt.candidate.stateHash, receipt.materialized.stateHash);
  const materialized = JSON.parse(await readFile(paths.outputPath, "utf8"));
  assert.equal(materialized.id, RELEASE_ID);
  assert.equal(materialized.routeVersions["route-version-full-1"].legs.length, 2);
  const interlockingRoutes = Object.values(materialized.interlockingRoutes)
    .sort((left, right) => left.authorityStartRouteMm - right.authorityStartRouteMm);
  assert.equal(interlockingRoutes.length, 2);
  assert.deepEqual(
    interlockingRoutes.map(({ authorityStartRouteMm, authorityEndRouteMm }) => ({
      authorityStartRouteMm,
      authorityEndRouteMm,
    })),
    [
      { authorityStartRouteMm: 0, authorityEndRouteMm: 1_000 },
      { authorityStartRouteMm: 1_000, authorityEndRouteMm: 2_200 },
    ],
  );
  assert.ok(interlockingRoutes[0].pathResources.includes("resource-observed-1"));
  assert.ok(!interlockingRoutes[0].pathResources.includes("resource-observed-2"));
  assert.ok(interlockingRoutes[1].pathResources.includes("resource-observed-2"));
  assert.ok(!interlockingRoutes[1].pathResources.includes("resource-observed-1"));
});
