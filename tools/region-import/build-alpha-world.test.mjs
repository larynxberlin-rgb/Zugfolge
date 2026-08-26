import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { alphaCanonicalJson, alphaHash } from "../../packages/alpha/dist/index.js";
import { operationalProtectionModeSelectionEvidence } from "../../packages/runtime-native/dist/index.js";
import {
  alphaServiceLotIdentifiers,
  assertSignedGtfsTimetableBinding,
  germanyOperationalStableId,
  streamTimetableRouteBindings,
  unwrapInfraReleaseManifest,
  publishCreateNewFileFromStaging,
  selectProtectionModeRuns,
  validateAlphaWorldBuildConfiguration,
  validateOperationalInitializationPreflightReceipt,
  verifyOperationalInfrastructureArtifact,
} from "./build-alpha-world.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildConfiguration() {
  return {
    schemaVersion: "zugfolge-alpha-world-build-configuration/v2",
    worldId: "e2695e40-3e4c-4e8c-9481-98f6223538d0",
    regionId: "fixture-region-b",
    regionVariant: "B",
    operatorId: "public",
    seed: "18446744073709551615",
    fleetReleaseId: "fleet-fixture-2026.3",
    planningAuthority: {
      accountId: "a2a545d2-74f7-40af-908d-1901ba2220bb",
      displayName: "Fixture-Aufgabentraeger",
    },
    operationalInfrastructure: {
      file: "operational-infrastructure-v2.json",
      bytes: 42,
      sha256: SHA_A,
      stateHash: SHA_B,
    },
    timetableRoutes: {
      file: "timetable-routes-v2.jsonseq",
      bytes: 84,
      sha256: SHA_A,
    },
  };
}

function infraWrapper(bytes, fileSha256) {
  const release = {
    schema: "zugfolge-infra-release/v2",
    releaseId: "infra-deutschland-fixture.1",
    artifacts: [{
      id: "operational-infrastructure-fixture.1",
      kind: "operational-infrastructure-v2",
      infraReleaseId: "infra-deutschland-fixture.1",
      file: "operational-infrastructure-v2.json",
      bytes,
      sha256: fileSha256,
      stateHash: SHA_B,
    }],
  };
  return { release, releaseHash: sha256(alphaCanonicalJson(release)) };
}

function route(playableLegId = "pl-fixture", templateId = `template:gtfs:${playableLegId}:v1`) {
  return {
    routeVersionId: `route:gtfs:${playableLegId}:v1`,
    templateId,
    predecessorId: null,
    transitionRouteMm: null,
    legs: [
      { edgeId: "edge-1", direction: "along", edgeEntryMm: 100, edgeExitMm: 1_100, availableProtectionSystems: ["pzb"], simultaneouslyRequiredProtectionSystems: [] },
      { edgeId: "edge-2", direction: "against", edgeEntryMm: 2_000, edgeExitMm: 500, availableProtectionSystems: ["pzb"], simultaneouslyRequiredProtectionSystems: [] },
    ],
  };
}

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-alpha-world-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Weltbuild verlangt explizite Welt-, Regions-, Operational-v2- und Routebindung", () => {
  const validated = validateAlphaWorldBuildConfiguration(buildConfiguration());
  assert.equal(validated.worldId, "e2695e40-3e4c-4e8c-9481-98f6223538d0");
  assert.equal(validated.seed, "18446744073709551615");
  for (const changed of [
    (value) => { delete value.worldId; },
    (value) => { value.worldId = "00000000-0000-4000-8000-000000000014"; },
    (value) => { value.seed = "0"; },
    (value) => { value.operationalInfrastructure.file = "../operational-infrastructure-v2.json"; },
    (value) => { value.timetableRoutes.file = "../timetable-routes-v2.jsonseq"; },
    (value) => { value.unknown = true; },
  ]) {
    const candidate = structuredClone(buildConfiguration());
    changed(candidate);
    assert.throws(() => validateAlphaWorldBuildConfiguration(candidate));
  }
});

test("Los- und Linienkennungen sind slug-kollisionsfrei, releasegebunden und weltneutral", () => {
  const common = { gtfsReleaseId: "gtfs-de-rv-20260812-aaaaaaaaaaaaaaaa", routeShortName: "RB 1" };
  const plus = alphaServiceLotIdentifiers({ ...common, routeId: "A+B" });
  const space = alphaServiceLotIdentifiers({ ...common, routeId: "A B" });
  const foreignRelease = alphaServiceLotIdentifiers({ ...common, gtfsReleaseId: "gtfs-de-rv-20260812-bbbbbbbbbbbbbbbb", routeId: "A+B" });
  assert.notEqual(plus.lotId, space.lotId);
  assert.notEqual(plus.serviceLineId, space.serviceLineId);
  assert.notEqual(plus.lotId, foreignRelease.lotId);
  assert.notEqual(plus.serviceLineId, foreignRelease.serviceLineId);
  assert.equal(plus.lotId.includes("e2695e40-3e4c-4e8c-9481-98f6223538d0"), false);
  assert.match(plus.lotId, /^lot-rb-1-[a-f0-9]{64}$/u);
  assert.match(plus.serviceLineId, /^line-rb-1-[a-f0-9]{64}$/u);
});

test("Create-new-Staging publiziert erst nach Erfolg und erlaubt einen sauberen Retry", async () => {
  await withTemporaryDirectory(async (root) => {
    const output = join(root, "alpha-world-deployment.json");
    await assert.rejects(
      publishCreateNewFileFromStaging(output, async ({ stagedOutputPath }) => {
        await writeFile(stagedOutputPath, "partial\n", { encoding: "utf8", flag: "wx" });
        throw new Error("injected-after-staged-fleet");
      }),
      /injected-after-staged-fleet/u,
    );
    await assert.rejects(readFile(output), { code: "ENOENT" });
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".staging-")), []);

    await publishCreateNewFileFromStaging(output, async ({ stagedOutputPath }) => {
      await writeFile(stagedOutputPath, "complete\n", { encoding: "utf8", flag: "wx" });
    });
    assert.equal(await readFile(output, "utf8"), "complete\n");
    await assert.rejects(
      publishCreateNewFileFromStaging(output, async () => undefined),
      /existiert bereits/u,
    );
  });
});

test("Operational-v2-Datei wird gestreamt und bytegenau an die kanonische Releasehuelle gebunden", async () => {
  await withTemporaryDirectory(async (root) => {
    const path = join(root, "operational-infrastructure-v2.json");
    const bytes = Buffer.from('{"fixture":"streamed"}\n', "utf8");
    await writeFile(path, bytes);
    const wrapper = infraWrapper(bytes.length, sha256(bytes));
    const unwrapped = unwrapInfraReleaseManifest(wrapper);
    const binding = await verifyOperationalInfrastructureArtifact(path, unwrapped.release);
    assert.deepEqual(binding, {
      schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
      infraReleaseId: "infra-deutschland-fixture.1",
      file: "operational-infrastructure-v2.json",
      bytes: bytes.length,
      sha256: sha256(bytes),
      stateHash: SHA_B,
    });

    const foreignWrapper = structuredClone(wrapper);
    foreignWrapper.release.releaseId = "infra-deutschland-foreign";
    assert.throws(() => unwrapInfraReleaseManifest(foreignWrapper), /kanonischen Releaseinhalt|Release-ID-Bindung/u);

    const traversalWrapper = structuredClone(wrapper);
    traversalWrapper.release.artifacts[0].file = "../operational-infrastructure-v2.json";
    traversalWrapper.releaseHash = sha256(alphaCanonicalJson(traversalWrapper.release));
    assert.throws(() => unwrapInfraReleaseManifest(traversalWrapper), /Datei|Operational-v2/u);

    await writeFile(path, Buffer.from('{"fixture":"tampered"}\n', "utf8"));
    await assert.rejects(verifyOperationalInfrastructureArtifact(path, unwrapped.release), /Bytezahl|SHA-256/u);
    const wrongName = join(root, "foreign.json");
    await writeFile(wrongName, bytes);
    await assert.rejects(verifyOperationalInfrastructureArtifact(wrongName, unwrapped.release), /Dateibindung/u);
  });
});

test("GTFS-Fach-IDs und Timetable-Routen bleiben an denselben signierten Release-Namespace gebunden", () => {
  const worldId = "e2695e40-3e4c-4e8c-9481-98f6223538d0";
  const snapshot = {
    serviceDate: "20260812",
    source: {
      archive: "gtfs-rv-free-2026-08-10.zip",
      archiveSha256: SHA_A,
      sourceLicense: "CC BY 4.0",
    },
    metrics: { orderableJourneyChainCount: 1 },
    segments: [{ orderable: true, qualityClass: "B" }],
    journeyChains: [{ worldId, releaseId: `gtfs-de-rv-20260812-${SHA_A.slice(0, 16)}` }],
  };
  const gtfsEnvelope = { snapshot, snapshotHash: sha256(alphaCanonicalJson(snapshot)) };
  const gtfsBytes = Buffer.from(`${JSON.stringify(gtfsEnvelope)}\n`, "utf8");
  const timetableRoutes = { file: "timetable-routes-v2.jsonseq", bytes: 84, sha256: SHA_B };
  const infraRelease = {
    schema: "zugfolge-infra-release/v2",
    timetableYear: 2026,
    sources: [{ id: "gtfs-de-regional-rail", sha256: SHA_A }],
    quality: {
      operationalClosure: {
        operationalQualityEligible: true,
        unresolvedRequired: 0,
        timetableRouteEvidence: {
          archive: snapshot.source.archive,
          archiveSha256: SHA_A,
          sourceLicenseAsPublished: snapshot.source.sourceLicense,
          gtfsSnapshotBytes: gtfsBytes.length,
          gtfsSnapshotSha256: sha256(gtfsBytes),
          snapshotHash: gtfsEnvelope.snapshotHash,
          routesBytes: timetableRoutes.bytes,
          routesSha256: timetableRoutes.sha256,
          routeSetSha256: timetableRoutes.sha256,
          routeRecordCount: 1,
          completeRouteCount: 1,
          selectedSegmentCount: 1,
        },
      },
    },
  };
  const input = { infraRelease, gtfsEnvelope, gtfsBytes, timetableRoutes, worldId };
  assert.equal(assertSignedGtfsTimetableBinding(input).routeRecordCount, 1);

  for (const mutate of [
    (value) => { value.gtfsEnvelope.snapshot.journeyChains[0].releaseId = "gtfs-de-rv-foreign"; },
    (value) => { value.gtfsEnvelope.snapshot.journeyChains[0].worldId = "00000000-0000-4000-8000-000000000999"; },
    (value) => { value.gtfsBytes = Buffer.from("tampered\n", "utf8"); },
    (value) => { value.timetableRoutes.sha256 = "c".repeat(64); },
    (value) => { value.infraRelease.quality.operationalClosure.unresolvedRequired = 1; },
    (value) => { value.infraRelease.sources.push({ id: "gtfs-de-regional-rail", sha256: SHA_A }); },
  ]) {
    const candidate = structuredClone(input);
    candidate.gtfsBytes = Buffer.from(candidate.gtfsBytes);
    mutate(candidate);
    assert.throws(() => assertSignedGtfsTimetableBinding(candidate), /signiert gebunden|nicht eindeutig/u);
  }
});

test("Timetable-JSONSeq wird zeilenweise auf vollstaendige Fahrwege und native Fahrstrassen-IDs reduziert", async () => {
  await withTemporaryDirectory(async (root) => {
    const path = join(root, "timetable-routes-v2.jsonseq");
    const bytes = Buffer.from(`${JSON.stringify(route())}\n${JSON.stringify(route("pl-other"))}\n`, "utf8");
    await writeFile(path, bytes);
    const proof = { file: "timetable-routes-v2.jsonseq", bytes: bytes.length, sha256: sha256(bytes) };
    const values = await streamTimetableRouteBindings(path, proof, new Set(["pl-fixture"]));
    assert.deepEqual(values.get("pl-fixture"), {
      playableLegId: "pl-fixture",
      routeVersionId: "route:gtfs:pl-fixture:v1",
      templateId: "template:gtfs:pl-fixture:v1",
      dispatchInterlockingRouteId: "interlocking:synthetic-segment:0c739e370c1cb8a67fccd2a267bcc93f09f4bd56d565be270c5e0885121fe9b8",
      routeLengthMm: 2_500,
      routeLegCount: 2,
      protectionContractRuns: [{
        throughRouteLegIndex: 1,
        availableProtectionSystems: ["pzb"],
        simultaneouslyRequiredProtectionSystems: [],
      }],
    });
    assert.equal(
      germanyOperationalStableId("interlocking:synthetic-segment:", ["route:gtfs:pl-fixture:v1", "1"]),
      values.get("pl-fixture").dispatchInterlockingRouteId,
    );
    await assert.rejects(streamTimetableRouteBindings(path, proof, new Set(["pl-missing"])), /fehlt/u);
    await assert.rejects(streamTimetableRouteBindings(path, { ...proof, sha256: SHA_A }, new Set(["pl-fixture"])), /SHA-256/u);

    const foreign = Buffer.from(`${JSON.stringify(route("pl-fixture", "template:foreign"))}\n`, "utf8");
    await writeFile(path, foreign);
    await assert.rejects(
      streamTimetableRouteBindings(path, { ...proof, bytes: foreign.length, sha256: sha256(foreign) }, new Set(["pl-fixture"])),
      /Template-Bindung/u,
    );
  });
});

test("S2 jc-7dbd4f2939d50c03dd54b283 waehlt fuer BR463 auf LZB/PZB konservativ PZB", () => {
  const common = {
    routeLegCount: 2,
    installedProtection: ["etcs-level2", "pzb"],
    context: "S2 jc-7dbd4f2939d50c03dd54b283 BR463.0",
  };
  assert.deepEqual(selectProtectionModeRuns({
    ...common,
    protectionContractRuns: [{
      throughRouteLegIndex: 1,
      availableProtectionSystems: ["lzb", "pzb"],
      simultaneouslyRequiredProtectionSystems: [],
    }],
  }), [{ throughRouteLegIndex: 1, selectedProtectionSystem: "pzb" }]);
  assert.throws(() => selectProtectionModeRuns({
    ...common,
    installedProtection: ["pzb"],
    protectionContractRuns: [{
      throughRouteLegIndex: 1,
      availableProtectionSystems: ["etcs-level2"],
      simultaneouslyRequiredProtectionSystems: [],
    }],
  }), /keinen kompatiblen Zugsicherungsmodus/u);
  assert.throws(() => selectProtectionModeRuns({
    ...common,
    installedProtection: ["pzb"],
    protectionContractRuns: [{
      throughRouteLegIndex: 1,
      availableProtectionSystems: ["lzb", "pzb"],
      simultaneouslyRequiredProtectionSystems: ["lzb"],
    }],
  }), /gleichzeitig zwingenden Zugsicherungssysteme/u);
});

test("644000 Legs bleiben als ein kanonischer Auswahl-Lauf kompakt", () => {
  const selections = selectProtectionModeRuns({
    routeLegCount: 644_000,
    installedProtection: ["pzb"],
    context: "Deutschland-Vollkorpus-Groessengrenze",
    protectionContractRuns: [{
      throughRouteLegIndex: 643_999,
      availableProtectionSystems: ["pzb"],
      simultaneouslyRequiredProtectionSystems: [],
    }],
  });
  assert.deepEqual(selections, [{
    throughRouteLegIndex: 643_999,
    selectedProtectionSystem: "pzb",
  }]);
  assert.ok(JSON.stringify(selections).length < 100);

  assert.throws(() => selectProtectionModeRuns({
    routeLegCount: 1,
    installedProtection: ["pzb"],
    context: "nichtkanonische Infrastruktur",
    protectionContractRuns: [{
      throughRouteLegIndex: 0,
      availableProtectionSystems: ["pzb", "lzb"],
      simultaneouslyRequiredProtectionSystems: [],
    }],
  }), /kanonisch sortiert/u);
});

test("nativer Streaming-Preflight muss Routen, Fahrstrassen, Ressourcen und Formationen explizit quittieren", () => {
  const initialization = {
    schemaVersion: "zugfolge-operational-simulation-initialize/v2",
    worldId: "e2695e40-3e4c-4e8c-9481-98f6223538d0",
    regionId: "fixture-region-b",
    nowMs: 0,
    protectionModeSelectionPolicy: "zugfolge-protection-mode-selection/conservative-v1",
    infraRelease: {
      schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
      infraReleaseId: "infra-fixture",
      file: "operational-infrastructure-v2.json",
      bytes: 42,
      sha256: SHA_A,
      stateHash: SHA_B,
    },
    vehicleTypes: [{}],
    vehicles: [{}],
    formations: [{}],
    trains: [
      { id: "train-1", trainNumber: "RE 99998", routeVersionId: "route-1", dispatchInterlockingRouteId: "dispatch-1", formationVersionId: "formation-1", protectionModeSelectionRuns: [{ throughRouteLegIndex: 0, selectedProtectionSystem: "pzb" }] },
      { id: "train-2", trainNumber: "ICE 99999", routeVersionId: "route-1", dispatchInterlockingRouteId: "dispatch-1", formationVersionId: "formation-1", protectionModeSelectionRuns: [{ throughRouteLegIndex: 0, selectedProtectionSystem: "pzb" }] },
    ],
  };
  const protectionEvidence = operationalProtectionModeSelectionEvidence(initialization);
  const receipt = {
    schemaVersion: "zugfolge-operational-initialization-validation-receipt/v1",
    worldId: initialization.worldId,
    regionId: initialization.regionId,
    initializationHash: alphaHash("zugfolge-operational-simulation-initialization/v2", initialization),
    stateHash: "d".repeat(64),
    infraRelease: structuredClone(initialization.infraRelease),
    dynamicTrainCount: 0,
    programTrainCount: 2,
    validatedProgramTemplateCount: 2,
    validatedRouteVersionCount: 1,
    validatedDispatchInterlockingRouteCount: 1,
    validatedResourceBindingCount: 6,
    validatedFormationBindingCount: 1,
    validatedTrainNumberCount: 2,
    protectionModeSelectionPolicy: initialization.protectionModeSelectionPolicy,
    validatedProtectionModeSelectionCount: protectionEvidence.count,
    protectionModeSelectionsSha256: protectionEvidence.sha256,
    protectionModeSelectionsValidated: true,
    resourceBindingsValidated: true,
    formationBindingsValidated: true,
    trainNumbersValidated: true,
    validationMode: "native-streaming-redb-v1",
  };
  assert.equal(validateOperationalInitializationPreflightReceipt(receipt, initialization).programTrainCount, 2);
  for (const field of ["resourceBindingsValidated", "formationBindingsValidated", "trainNumbersValidated"]) {
    assert.throws(() => validateOperationalInitializationPreflightReceipt({ ...receipt, [field]: false }, initialization), /Preflight/u);
  }
  assert.throws(() => validateOperationalInitializationPreflightReceipt({ ...receipt, validatedDispatchInterlockingRouteCount: 2 }, initialization), /Preflight/u);
  assert.throws(() => validateOperationalInitializationPreflightReceipt({ ...receipt, validatedProgramTemplateCount: 1 }, initialization), /Preflight/u);
  assert.throws(() => validateOperationalInitializationPreflightReceipt({ ...receipt, validatedResourceBindingCount: 0 }, initialization), /Preflight/u);
  assert.throws(() => validateOperationalInitializationPreflightReceipt({ ...receipt, validatedFormationBindingCount: 2 }, initialization), /Preflight/u);
  assert.throws(() => validateOperationalInitializationPreflightReceipt({ ...receipt, validatedTrainNumberCount: 1 }, initialization), /Preflight/u);
  assert.throws(() => validateOperationalInitializationPreflightReceipt({ ...receipt, initializationHash: "c".repeat(64) }, initialization), /Preflight/u);
  assert.throws(() => validateOperationalInitializationPreflightReceipt({ ...receipt, unknown: true }, initialization), /fehlende oder unbekannte/u);
  assert.throws(() => validateOperationalInitializationPreflightReceipt({
    ...receipt,
    infraRelease: { ...receipt.infraRelease, sha256: "c".repeat(64) },
  }, initialization), /Preflight/u);
});

test("Builder liest die Deutschland-Infrastruktur nie als JSON-String und enthaelt keine alte Welt-14-Bindung", async () => {
  const [worldSource, gtfsSource] = await Promise.all([
    readFile(new URL("./build-alpha-world.mjs", import.meta.url), "utf8"),
    readFile(new URL("./build-gtfs-region.mjs", import.meta.url), "utf8"),
  ]);
  assert.equal(worldSource.includes("readFile(operationalV2Path"), false);
  assert.equal(worldSource.includes("JSON.parse(operationalV2"), false);
  assert.equal(worldSource.includes("infra.routeVersions"), false);
  assert.equal(worldSource.includes("infra.interlockingRoutes"), false);
  assert.equal(worldSource.includes("infra.blockResources"), false);
  assert.equal(worldSource.includes("operational-network.json"), false);
  assert.equal(worldSource.includes("${resolve(outputPath)}.fleet.json"), false);
  assert.equal(worldSource.includes("projectLegacyOperationalFleet"), false);
  assert.match(worldSource, /ausschliesslich einen reproduzierbar kompilierten Fleet-Authority-v2-Artefaktsatz/u);
  assert.match(worldSource, /validateOperationalInitializationPreflightReceipt\(receipt, value\)/u);
  assert.doesNotMatch(worldSource, /const WORLD_ID = "00000000-0000-4000-8000-000000000014"/u);
  assert.doesNotMatch(gtfsSource, /const WORLD_ID = "00000000-0000-4000-8000-000000000014"/u);
  assert.match(gtfsSource, /worldId: WORLD_ID/u);
  assert.match(gtfsSource, /regionId: REGION_ID/u);
  assert.match(worldSource, /operationalInfrastructureSha256: operationalInfrastructureBinding\.sha256/u);
  assert.match(worldSource, /operationalInfrastructureStateHash: operationalInfrastructureBinding\.stateHash/u);
  assert.match(worldSource, /operationalSimulationSourceSha256 = sha256\(alphaCanonicalJson\(operationalSimulation\)\)/u);
  assert.match(worldSource, /for \(const \[playableIndex, leg\] of chainPlayableLegs\.entries\(\)\)/u);
  assert.match(worldSource, /lotTrainRunIds\.push\(trainRunId\)/u);
  assert.match(worldSource, /publishCreateNewFileFromStaging\(outputPath/u);
  assert.doesNotMatch(worldSource, /const firstPlayableLegByChain/u);
});
