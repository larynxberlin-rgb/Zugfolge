import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { deriveSignedReleaseSourceFile } from "../../tiles/signed-map-package-plan.mjs";
import { validateMapReleaseBuildEvidenceSpec } from "../../tiles/map-release-build-evidence.mjs";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

async function text(path) {
  return readFile(resolve(root, path), "utf8");
}

async function json(path) {
  return JSON.parse(await text(path));
}

const annualFiles = [
  "tools/region-import/germany/release.annual-2026.3.config.json",
  "tools/region-import/germany/operational-infrastructure.annual-2026.3.json",
  "tools/region-import/germany/release-artifacts.annual-2026.3.json",
  "tools/region-import/germany/final-map-layers.annual-2026.3.json",
  "tools/region-import/germany/final-quality-inputs.annual-2026.3.json",
  "tools/region-import/germany/semantic-tile-inputs.annual-2026.3.json",
  "tools/tiles/livemap-read-model.annual-2026.3.json",
  "tools/tiles/map-release.annual-2026.3.spec.json",
  "tools/tiles/map-package.annual-2026.3.plan.json",
  "tools/tiles/map-build-cache-inventory.annual-2026.3.plan.json",
  "tools/tiles/map-release-build-evidence.annual-2026.3.spec.json",
];

test("historische 2026.4-Timetable-Routen binden nur den lokalen freien GTFS-Snapshot und freie Semantiklayer", async () => {
  const specification = await json("tools/region-import/germany/timetable-route-compiler.annual-2026.4.json");
  assert.equal(specification.schema, "zugfolge-germany-timetable-route-compiler/v3");
  assert.equal(specification.infraReleaseId, "infra-deutschland-2026.4");
  assert.equal(Object.hasOwn(specification, "operationalNetwork"), false);
  assert.equal(specification.tracks, "var/derived/germany-2026.4/semantic-tile-inputs-free-v2/tracks.geojsonseq");
  assert.equal(specification.corridors, "var/derived/germany-2026.4/semantic-tile-inputs-free-v2/rail-corridors.geojsonseq");
  assert.equal(specification.gtfsSnapshot.path, "var/derived/germany-2026.4/gtfs-region-20260810-v2.json");
  assert.equal(specification.gtfsSnapshot.expectedFileSha256, "cbebbcb73e1807df793c26411873b2df442e6ce38d28fd0593a78e5ae93912c5");
  assert.equal(specification.gtfsSnapshot.expectedSnapshotHash, "811fcafe581e73409b373ec5e2568dbb44048d604be834d1aa998abe4a35a8a7");
  assert.equal(specification.gtfsSnapshot.expectedSourceLicense, "CC BY 4.0");
  assert.deepEqual({
    rule: specification.selection.rule,
    qualityClass: specification.selection.qualityClass,
    requireOrderable: specification.selection.requireOrderable,
    minimumStopCount: specification.selection.minimumStopCount,
    expectedSnapshotSegmentCount: specification.selection.expectedSnapshotSegmentCount,
    expectedEligibleSegmentCount: specification.selection.expectedEligibleSegmentCount,
    permittedProtectionModes: specification.selection.permittedProtectionModes,
  }, {
    rule: "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
    qualityClass: "B",
    requireOrderable: true,
    minimumStopCount: 2,
    expectedSnapshotSegmentCount: 2481,
    expectedEligibleSegmentCount: 1679,
    permittedProtectionModes: ["pzb"],
  });
  assert.equal(Object.hasOwn(specification, "dailyCirculation"), false);
  assert.equal(Object.hasOwn(specification, "transferOutput"), false);
});

test("Jahreskonfiguration 2026.3 bindet dieselbe Release-ID und keine Zugprojektion", async () => {
  const [
    releaseConfig,
    operationalDerivation,
    artifactSpec,
    finalMapLayers,
    finalQuality,
    semanticTiles,
    readModel,
    mapRelease,
    mapPackage,
    cachePlan,
    buildEvidence,
  ] = await Promise.all(annualFiles.map(json));

  assert.equal(releaseConfig.release.releaseId, "infra-deutschland-2026.3");
  assert.equal(releaseConfig.release.timetableYear, 2026);
  assert.equal(Object.hasOwn(releaseConfig.pipeline, "annualSourceCaptures"), false);
  assert.deepEqual(releaseConfig.pipeline.operationalDeriver, {
    entrypoint: "tools/region-import/germany/run-operational-infrastructure-v2.mjs",
    specification: "tools/region-import/germany/operational-infrastructure.annual-2026.3.json",
    candidate: "var/derived/germany-2026.3/operational-infrastructure-v2.candidate.json",
    report: "var/derived/germany-2026.3/operational-infrastructure-v2.derivation-report.json",
    output: "var/derived/germany-2026.3/operational-infrastructure-v2.json",
  });
  assert.equal(operationalDerivation.infraReleaseId, "infra-deutschland-2026.3");
  assert.equal(operationalDerivation.schema, "zugfolge-germany-operational-infrastructure-derivation/v2");
  assert.equal(operationalDerivation.mode, "deterministic-conservative-v1");
  assert.equal(operationalDerivation.layers.transferDemands, null);
  assert.deepEqual(Object.entries(operationalDerivation.layers).filter(([name]) => name !== "transferDemands").map(([, value]) => value), [
    "var/derived/germany-2026.3/final-map-layers-v2/tracks.geojsonseq",
    "var/derived/germany-2026.3/final-map-layers-v2/platforms.geojsonseq",
    "var/derived/germany-2026.3/final-map-layers-v2/switches.geojsonseq",
    "var/derived/germany-2026.3/final-map-layers-v2/signals.geojsonseq",
    "var/derived/germany-2026.3/final-map-layers-v2/blocks.geojsonseq",
    "var/derived/germany-2026.3/final-map-layers-v2/conflict-resources.geojsonseq",
    "var/derived/germany-2026.3/timetable-routes-v2.jsonseq",
  ]);
  assert.deepEqual(operationalDerivation.policy, {
    id: "synthetic-operational-b/v2",
    qualityClass: "B",
    sourceId: "zugfolge-synthetic-operational-model",
    derivationRule: "synthetic-operational-b/v2",
    unknownMainlineSpeedKmh: 20,
    unknownServiceSpeedKmh: 10,
    unknownGradientAbsPermille: 40,
    minimumPlatformLengthMm: 60000,
    maximumPlatformSnapDistanceMm: 25000,
    minimumOverlapMm: 200000,
    minimumBerthEndClearanceMm: 10000,
    maximumDirectDwellMs: 1200000,
    terminalFormationLengthsMm: [46560, 69860],
    defaultProtectionSystem: "pzb",
    regionBoundaryId: "region:deutschland-ebo",
    rzueLayoutId: "rzue-deutschland-2026.3-synthetic-b-v2",
  });
  assert.equal(Object.hasOwn(operationalDerivation, "operationalInputs"), false);
  assert.equal(finalQuality.releaseId, "infra-deutschland-2026.3");
  assert.equal(finalQuality.timetableYear, 2026);
  assert.match(finalMapLayers.outputDirectory, /germany-2026\.3/u);
  assert.equal(semanticTiles.outputDirectory, "var/derived/germany-2026.3/semantic-tile-inputs-free-v2");
  assert.equal(readModel.infrastructureReleaseId, "infra-deutschland-2026.3");
  assert.equal(readModel.worldId, "0db56535-a466-44a8-a991-38a8a1f7566c");
  assert.equal(readModel.config.worldId, readModel.worldId);
  assert.equal(readModel.worldEpoch, "2026-08-10T00:00:00.000Z");
  assert.equal(readModel.serviceStartOffsetS, 0);
  assert.equal(readModel.repeatEveryS, 86_400);
  assert.equal(readModel.gtfs.serviceDate, "20260810");
  assert.equal(readModel.gtfs.trainIdentity.releaseId, "gtfs-de-rv-20260810-{archiveSha16}");
  assert.equal(readModel.inputDirectory, "../../var/derived/germany-2026.3/semantic-tile-inputs-free-v2");
  assert.equal(readModel.config.infrastructureReleaseId, "infra-deutschland-2026.3");
  assert.equal(mapRelease.releaseId, "infra-deutschland-2026.3");
  assert.equal(mapRelease.artifacts.find(({ kind }) => kind === "infrastructure").file, "var/derived/germany-2026.3/map-release-free-v2/infra-deutschland-2026.3.pmtiles");

  assert.equal(artifactSpec.schema, "zugfolge-infra-release-artifact-spec/v2");
  assert.deepEqual(artifactSpec.artifacts.map(({ id, kind }) => ({ id, kind })), [
    { id: "infra-deutschland-2026.3", kind: "infrastructure" },
    { id: "livemap-read-model-2026.3", kind: "read-model" },
    { id: "operational-infrastructure-2026.3", kind: "operational-infrastructure-v2" },
    { id: "quality-report-2026.3", kind: "quality-report" },
  ]);
  const operationalArtifact = artifactSpec.artifacts.find(({ kind }) => kind === "operational-infrastructure-v2");
  assert.deepEqual(operationalArtifact, {
    id: "operational-infrastructure-2026.3",
    kind: "operational-infrastructure-v2",
    infraReleaseId: "infra-deutschland-2026.3",
    sourceFile: "var/derived/germany-2026.3/operational-infrastructure-v2.json",
    file: "operational-infrastructure-v2.json",
  });
  assert.deepEqual(artifactSpec.artifacts.find(({ kind }) => kind === "quality-report"), {
    id: "quality-report-2026.3",
    kind: "quality-report",
    sourceFile: "var/derived/germany-2026.3/operational-infrastructure-quality.json",
    file: "operational-infrastructure-quality.json",
  });

  assert.equal(mapPackage.schema, "zugfolge-map-package-plan/v2");
  assert.equal(mapPackage.version, "2026.3");
  assert.equal(mapPackage.runtime.schema, "zugfolge-map-runtime/v2");
  const packagedOperational = mapPackage.auxiliaryFiles.find(({ kind }) => kind === "operational-infrastructure-v2");
  assert.deepEqual(packagedOperational, {
    id: "operational-infrastructure-2026.3",
    kind: "operational-infrastructure-v2",
    visibility: "public",
    sourceFile: "var/derived/germany-2026.3/operational-infrastructure-v2.json",
    installPath: "operational-infrastructure-v2.json",
    artifactInventory: "var/derived/germany-2026.3/release-artifacts.v2.json",
  });
  assert.equal(
    mapPackage.auxiliaryFiles.find(({ kind }) => kind === "quality-manifest").sourceFile,
    "var/derived/germany-2026.3/operational-infrastructure-quality.json",
  );
  assert.equal(
    mapPackage.auxiliaryFiles.find(({ kind }) => kind === "release-manifest").sourceFile,
    "var/derived/germany-2026.3/map-release-free-v2/delivery-unsigned/release.json",
  );
  assert.equal(
    deriveSignedReleaseSourceFile(mapPackage.auxiliaryFiles.find(({ kind }) => kind === "release-manifest").sourceFile),
    "var/derived/germany-2026.3/map-release-free-v2/public/release.json",
  );
  assert.equal(
    mapPackage.auxiliaryFiles.find(({ kind }) => kind === "source-manifest").sourceFile,
    "var/derived/germany-2026.3/map-release-free-v2/delivery-unsigned/sources.json",
  );
  assert.equal(mapPackage.auxiliaryFiles.some(({ kind }) => kind === "train-map-projection"), false);
  assert.equal(Object.hasOwn(packagedOperational, "expectedBytes"), false);
  assert.equal(Object.hasOwn(packagedOperational, "expectedSha256"), false);
  assert.equal(Object.hasOwn(packagedOperational, "stateHash"), false);

  assert.equal(cachePlan.releaseId, "infra-deutschland-2026.3");
  const cachedSources = cachePlan.files.map(({ sourceFile }) => sourceFile);
  const cachedTargets = cachePlan.files.map(({ cacheFile }) => cacheFile);
  assert.equal(new Set(cachedSources).size, cachedSources.length);
  assert.equal(new Set(cachedTargets).size, cachedTargets.length);
  assert.ok(cachedSources.includes("var/derived/germany-2026.3/operational-infrastructure-v2.json"));
  assert.ok(cachedSources.includes("var/derived/germany-2026.3/operational-infrastructure-v2.derivation-report.json"));
  assert.ok(cachedSources.includes("var/derived/germany-2026.3/release-artifacts.v2.json"));
  assert.ok(cachedSources.includes("var/derived/germany-2026.3/source-capture.2026.3.json"));
  assert.equal(cachedSources.some((path) => /trassenfinder-infrastruktur/u.test(path)), false);
  assert.equal(cachedSources.some((path) => /train-map-projection|alpha-world-deployment|operational-network/u.test(path)), false);

  assert.equal(buildEvidence.schema, "zugfolge-map-release-build-evidence-spec/v2");
  assert.equal(buildEvidence.releaseId, "infra-deutschland-2026.3");
  assert.equal(buildEvidence.previousReleaseId, "infra-deutschland-2026.2");
  assert.equal(Object.hasOwn(buildEvidence, "commits"), false);
  assert.equal(Object.hasOwn(buildEvidence, "requiredSourceCaptures"), false);
  assert.equal(buildEvidence.inputs.some(({ id }) => id === "stada-source-archive"), false);
  assert.equal(buildEvidence.inputs.some(({ id }) => id === "trassenfinder-infrastructure"), false);
  assert.ok(buildEvidence.inputs.some(({ id, kind, expectedBytes, expectedSha256 }) => id === "openstation-netex"
    && kind === "source-archive"
    && expectedBytes === 303425534
    && expectedSha256 === "04f489a1cb7bb9513e10c90d5d613e0f21265c8ed6b8f3f342f85f7fab7623b3"));
  assert.ok(buildEvidence.inputs.some(({ id, file }) => id === "operational-infrastructure-derivation-spec"
    && file === "tools/region-import/germany/operational-infrastructure.annual-2026.3.json"));
  assert.ok(buildEvidence.inputs.some(({ id, file }) => id === "operational-infrastructure-derivation-report"
    && file === "var/derived/germany-2026.3/operational-infrastructure-v2.derivation-report.json"));
  assert.ok(buildEvidence.inputs.some(({ id, kind, file }) => id === "map-package-base-plan"
    && kind === "specification"
    && file === "tools/tiles/map-package.annual-2026.3.plan.json"));
  assert.deepEqual(buildEvidence.candidatePackage, {
    basePlanInputId: "map-package-base-plan",
    signedPlanFile: "var/derived/germany-2026.3/map-release-free-v2/signed-package-plan.json",
    trustedKeysFile: "ops/keys/trusted-delivery-keys.json",
    retainedTrustedKeyIds: ["zugfolge-alpha-2026", "zugfolge-alpha-2026.3"],
  });
  assert.deepEqual(buildEvidence.outputs.map(({ kind }) => kind), [
    "basemap-pmtiles",
    "semantic-pmtiles",
    "read-model",
    "operational-infrastructure-v2",
    "style",
    "delivery-manifest",
    "quality-report",
  ]);
  assert.deepEqual(buildEvidence.outputs.find(({ kind }) => kind === "operational-infrastructure-v2"), {
    id: "operational-infrastructure",
    kind: "operational-infrastructure-v2",
    file: "var/derived/germany-2026.3/operational-infrastructure-v2.json",
    installFile: "operational-infrastructure-v2.json",
  });
  assert.equal(
    buildEvidence.outputs.find(({ kind }) => kind === "quality-report").file,
    "var/derived/germany-2026.3/operational-infrastructure-quality.json",
  );
  assert.deepEqual(
    buildEvidence.inputs.filter(({ id }) => ["infra-release-wrapper", "map-release-wrapper", "delivery-sources"].includes(id))
      .map(({ id, file }) => ({ id, file })),
    [
      { id: "infra-release-wrapper", file: "var/derived/germany-2026.3/map-release-free-v2/public/infra-release.json" },
      { id: "map-release-wrapper", file: "var/derived/germany-2026.3/map-release-free-v2/public/map-release.json" },
      { id: "delivery-sources", file: "var/derived/germany-2026.3/map-release-free-v2/delivery-unsigned/sources.json" },
    ],
  );

  const rawAnnualFiles = await Promise.all(annualFiles.map(text));
  assert.equal(rawAnnualFiles.some((contents) => contents.includes("train-map-projection")), false);
  assert.equal(rawAnnualFiles.slice(0, -1).some((contents) => contents.includes("2026.2")), false);
  const tileFiles = await readdir(resolve(root, "tools/tiles"));
  assert.equal(tileFiles.includes("train-map-projection.annual-2026.3.json"), false);
});

test("Jahrespatch 2026.4 bindet alle neuen Releaseausgaben und kennzeichnet nur gepinnte 2026.3-Eingaben als Wiederverwendung", async () => {
  const [
    releaseConfig,
    operationalDerivation,
    closure,
    closurePolicy,
    operationalQuality,
    artifactSpec,
    finalQuality,
    sourceCapture,
    readModel,
    staticQuality,
    staticSources,
    mapRelease,
    staticRelease,
    mapPackage,
    cachePlan,
    buildEvidence,
  ] = await Promise.all([
    "tools/region-import/germany/release.annual-2026.4.config.json",
    "tools/region-import/germany/operational-infrastructure.annual-2026.4.json",
    "tools/region-import/germany/synthetic-operational-closure.annual-2026.4.json",
    "tools/region-import/germany/synthetic-operational-b.2026.4.policy.json",
    "tools/region-import/germany/operational-quality.annual-2026.4.json",
    "tools/region-import/germany/release-artifacts.annual-2026.4.json",
    "tools/region-import/germany/final-quality-inputs.annual-2026.4.json",
    "tools/region-import/germany/source-capture.annual-2026.4.plan.json",
    "tools/tiles/livemap-read-model.annual-2026.4.json",
    "tools/tiles/static-map-quality.annual-2026.4.json",
    "tools/tiles/static-map-sources.annual-2026.4.json",
    "tools/tiles/map-release.annual-2026.4.spec.json",
    "tools/tiles/static-map-release.annual-2026.4.json",
    "tools/tiles/map-package.annual-2026.4.plan.json",
    "tools/tiles/map-build-cache-inventory.annual-2026.4.plan.json",
    "tools/tiles/map-release-build-evidence.annual-2026.4.spec.json",
  ].map(json));

  assert.equal(releaseConfig.release.releaseId, "infra-deutschland-2026.4");
  assert.equal(operationalDerivation.infraReleaseId, "infra-deutschland-2026.4");
  assert.equal(closure.releaseId, "infra-deutschland-2026.4");
  assert.equal(closure.policyFile, "tools/region-import/germany/synthetic-operational-b.2026.4.policy.json");
  assert.deepEqual(closurePolicy.compilerPolicy, operationalDerivation.policy);
  assert.equal(operationalQuality.releaseId, "infra-deutschland-2026.4");
  assert.equal(operationalQuality.policyFile, closure.policyFile);
  assert.equal(finalQuality.releaseId, "infra-deutschland-2026.4");
  assert.equal(sourceCapture.releaseId, "infra-deutschland-2026.4");
  assert.equal(readModel.infrastructureReleaseId, "infra-deutschland-2026.4");
  assert.equal(readModel.config.infrastructureReleaseId, "infra-deutschland-2026.4");
  assert.equal(staticQuality.infrastructureCorpusId, "infra-deutschland-2026.4");
  assert.equal(staticSources.releaseId, "infra-deutschland-2026.4");
  assert.equal(mapRelease.releaseId, "infra-deutschland-2026.4");
  assert.equal(staticRelease.corpusId, "infra-deutschland-2026.4");
  assert.equal(mapPackage.version, "2026.4");
  assert.equal(cachePlan.releaseId, "infra-deutschland-2026.4");
  assert.equal(buildEvidence.releaseId, "infra-deutschland-2026.4");
  assert.equal(buildEvidence.previousReleaseId, "infra-deutschland-2026.2");
  assert.equal(
    buildEvidence.candidatePackage.signedPlanFile,
    "var/derived/germany-2026.4/map-release-free-v2/signed-package-plan.json",
  );
  assert.deepEqual(artifactSpec.artifacts.map(({ id }) => id), [
    "infra-deutschland-2026.4",
    "livemap-read-model-2026.4",
    "operational-infrastructure-2026.4",
    "quality-report-2026.4",
  ]);

  const currentReleaseContracts = [
    releaseConfig,
    operationalDerivation,
    closure,
    closurePolicy,
    operationalQuality,
    artifactSpec,
    finalQuality,
    readModel,
    staticQuality,
    staticSources,
    mapRelease,
    staticRelease,
    mapPackage,
  ];
  for (const contract of currentReleaseContracts) {
    assert.doesNotMatch(JSON.stringify(contract), /infra-deutschland-2026\.3|germany-2026\.3/u);
  }
  assert.ok(sourceCapture.sources.every(({ input, manifest }) => `${input ?? manifest}`.includes("annual-2026-pinned/")));
  assert.ok(cachePlan.files.some(({ sourceFile }) => sourceFile.includes("copernicus-dem-glo30-2021-2026.3")));
  assert.ok(cachePlan.files.filter(({ sourceFile }) => sourceFile.startsWith("var/derived/")).every(({ sourceFile }) => sourceFile.startsWith("var/derived/germany-2026.4/")));
  assert.ok(buildEvidence.inputs.filter(({ file }) => file.startsWith("var/derived/")).every(({ file }) => file.startsWith("var/derived/germany-2026.4/")));
  assert.ok(buildEvidence.outputs.every(({ file }) => !file.startsWith("var/derived/") || file.startsWith("var/derived/germany-2026.4/")));
  assert.deepEqual(
    buildEvidence.inputs.filter(({ file }) => file.includes("annual-2026.3")).map(({ id }) => id),
    ["official-operating-points-spec", "semantic-tile-assembly-spec", "final-map-layer-spec"],
  );
  const reusedSpecifications = buildEvidence.inputs.filter(({ reuse }) => reuse !== undefined);
  assert.deepEqual(reusedSpecifications.map(({ id }) => id), [
    "official-operating-points-spec",
    "semantic-tile-assembly-spec",
    "final-map-layer-spec",
  ]);
  assert.equal(reusedSpecifications.reduce((count, { reuse }) => count + reuse.artifacts.length, 0), 20);
  for (const specification of reusedSpecifications) {
    assert.equal(specification.version, "infra-deutschland-2026.3");
    assert.equal(specification.reuse.mode, "byte-identical-cross-release");
    assert.equal(specification.reuse.sourceReleaseId, "infra-deutschland-2026.3");
    assert.equal(specification.reuse.targetReleaseId, "infra-deutschland-2026.4");
    assert.ok(specification.reuse.artifacts.every(({ sourceFile, targetFile, bytes, sha256 }) =>
      sourceFile.startsWith("var/derived/germany-2026.3/")
        && targetFile === sourceFile.replace("germany-2026.3", "germany-2026.4")
        && Number.isSafeInteger(bytes)
        && bytes > 0
        && /^[a-f0-9]{64}$/u.test(sha256)));
  }
});

test("Signed-Paketplan wird nur reproduzierbar aus dem Runtime-v2-Jahresplan abgeleitet", async () => {
  const [mapPackage, buildEvidence, trustedKeys, trustedKeyScopes, releaseDocumentation, annualPrompt, map2026Dot5PublicKey] = await Promise.all([
    json("tools/tiles/map-package.annual-2026.4.plan.json"),
    json("tools/tiles/map-release-build-evidence.annual-2026.4.spec.json"),
    json("ops/keys/trusted-delivery-keys.json"),
    json("ops/keys/trusted-delivery-key-scopes.json"),
    text("docs/kartenrelease-deutschland-2026.4-v2.md"),
    text("docs/prompts/infrarelease-deutschland-jahreslauf.md"),
    text("ops/keys/zugfolge-map-deutschland-2026.5-ed25519-public.pem"),
  ]);
  const releases = mapPackage.auxiliaryFiles.filter(({ kind }) => kind === "release-manifest");
  assert.equal(mapPackage.schema, "zugfolge-map-package-plan/v2");
  assert.equal(mapPackage.runtime.schema, "zugfolge-map-runtime/v2");
  assert.equal(releases.length, 1);
  assert.equal(releases[0].id, "release-manifest");
  assert.equal(releases[0].installPath, "manifests/release.json");
  assert.equal(
    deriveSignedReleaseSourceFile(releases[0].sourceFile),
    "var/derived/germany-2026.4/map-release-free-v2/public/release.json",
  );
  assert.equal(Object.hasOwn(releases[0], "expectedBytes"), false);
  assert.equal(Object.hasOwn(releases[0], "expectedSha256"), false);
  assert.equal(buildEvidence.candidatePackage.basePlanInputId, "map-package-base-plan");
  assert.equal(buildEvidence.candidatePackage.signedPlanFile, "var/derived/germany-2026.4/map-release-free-v2/signed-package-plan.json");
  assert.equal(buildEvidence.candidatePackage.trustedKeysFile, "ops/keys/trusted-delivery-keys.json");
  assert.deepEqual(trustedKeyScopes.mapInfraDeliveries, [
    "zugfolge-map-deutschland-2026.4",
    "zugfolge-map-deutschland-2026.5",
  ]);
  assert.deepEqual(trustedKeyScopes.alphaWorldDeployments, buildEvidence.candidatePackage.retainedTrustedKeyIds);
  assert.equal(
    new Set([...trustedKeyScopes.alphaWorldDeployments, ...trustedKeyScopes.mapInfraDeliveries]).size,
    Object.keys(trustedKeys).length,
  );
  assert.deepEqual(
    [...trustedKeyScopes.alphaWorldDeployments, ...trustedKeyScopes.mapInfraDeliveries].sort(),
    Object.keys(trustedKeys).sort(),
  );
  assert.equal(
    trustedKeys["zugfolge-map-deutschland-2026.5"],
    map2026Dot5PublicKey,
    "der eingecheckte .5-Public-Key muss bytegleich im Trust-Register stehen",
  );
  assert.deepEqual(
    buildEvidence.candidatePackage.retainedTrustedKeyIds,
    ["zugfolge-alpha-2026", "zugfolge-alpha-2026.3"],
  );
  assert.equal(buildEvidence.candidatePackage.retainedTrustedKeyIds.includes("zugfolge-map-deutschland-2026.3"), false);
  for (const keyId of buildEvidence.candidatePackage.retainedTrustedKeyIds) {
    assert.match(trustedKeys[keyId], /BEGIN PUBLIC KEY/u);
  }
  for (const documentation of [releaseDocumentation, annualPrompt]) {
    assert.match(documentation, /signed-map-package-plan-cli\.mjs/u);
    assert.match(documentation, /signed-package-plan\.json/u);
    assert.match(documentation, /ops\/keys\/trusted-delivery-keys\.json/u);
    assert.match(documentation, /ops\/keys\/trusted-delivery-key-scopes\.json/u);
    assert.match(documentation, /zugfolge-map-package-spec\/v2/u);
    assert.match(documentation, /jede(?: einzelne)?\s+expandierte\s+Paketdatei/u);
    assert.match(documentation, /vollständig\s+gepinnten unsigned Spezifikation/u);
  }
  assert.match(releaseDocumentation, /zugfolge-map-deutschland-2026\.3[\s\S]*bleibt aus[\s\S]*trusted-delivery-keys\.json[\s\S]*ausgeschlossen/u);
  assert.match(releaseDocumentation, /alten Map-Key[\s\S]*entfernen[\s\S]*neuen öffentlichen \.4-Key additiv/u);
  assert.match(
    releaseDocumentation,
    /integriertes Paket signed \|[^\n]*b773792afbe1bc4d487e3465f02f415d2e1fe9137559d4560ff785c3f6f74d1b[^\n]*'installed' grün/u,
  );
  assert.doesNotMatch(releaseDocumentation, /integriertes Paket unsigned[^\n]*#425-Vertrag gesperrt/u);
  assert.match(
    releaseDocumentation,
    /map-package-cli\.mjs pack var\/derived\/germany-2026\.4\/map-release-free-v2\/signed-package-plan\.json var\/map-package\/zugfolge-map-deutschland-2026\.4-v2-signed \./u,
  );
  assert.match(
    annualPrompt,
    /map-package-cli\.mjs pack <ARTEFAKTWURZEL>\/map-release-free-v2\/signed-package-plan\.json <ARTEFAKTWURZEL>\/map-package-signed \./u,
  );
  for (const documentation of [releaseDocumentation, annualPrompt]) {
    assert.doesNotMatch(documentation, /map-package-cli\.mjs pack-plan (?:tools\/tiles\/)?map-package\.annual-/u);
    assert.doesNotMatch(documentation, /unsignierter Kandidat darf gepackt/u);
  }
  assert.doesNotMatch(releaseDocumentation, /pack-plan var\/derived\/germany-2026\.4\/map-release-free-v2\/signed-package-plan\.json/u);
});

test("Kartenanleitung baut Sources-v3 aus dem echten v2-Capture in harter Reihenfolge", async () => {
  const documentation = await text("docs/kartenrelease-deutschland-2026.4-v2.md");
  const infraRelease = documentation.indexOf("build-germany-release.mjs manifest");
  const mapCapture = documentation.indexOf("build-map-source-capture.mjs");
  const staticSources = documentation.indexOf("static-map-sources-cli.mjs materialize");
  const mapRelease = documentation.indexOf("build-map-release.mjs");
  const delivery = documentation.indexOf("build-map-delivery-release.mjs");
  const signedPlan = documentation.indexOf("signed-map-package-plan-cli.mjs", delivery + 1);
  const integratedPackage = documentation.indexOf("node tools/tiles/map-package-cli.mjs pack ", signedPlan + 1);

  assert.ok(infraRelease >= 0 && infraRelease < mapCapture);
  assert.ok(mapCapture < staticSources && staticSources < mapRelease);
  assert.ok(mapRelease < delivery && delivery < signedPlan && signedPlan < integratedPackage);
  assert.doesNotMatch(documentation.slice(delivery, signedPlan), /map-package-cli\.mjs (?:pack|pack-plan)/u);
  assert.match(documentation, /static-map-sources-cli\.mjs materialize[\s\S]*map-release-free-v2\/public\/map-source-capture\.json[\s\S]*map-asset-notices\.annual-2026\.3\.json[\s\S]*map-release-free-v2\/public\/static-map-sources-v2\.json/u);
  assert.match(documentation, /build-map-delivery-release\.mjs[\s\S]*public\/infra-release\.json[\s\S]*public\/map-release\.json[\s\S]*public\/read-model\.sqlite\.report\.json[\s\S]*delivery-unsigned/u);
  assert.doesNotMatch(documentation, /basemap-source-capture-2026-08-12\.json/u);
});

test("historische 2026.3-Kartenanleitung bleibt reproduzierbar, aber eindeutig abgeloest", async () => {
  const documentation = await text("docs/kartenrelease-deutschland-2026.3-v2.md");
  const command = (script) => {
    const prefix = `node ${script} `;
    const matches = documentation.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
    assert.equal(matches.length, 1, `${script} muss genau einmal als einzeiliger Aufruf dokumentiert sein.`);
    return matches[0].split(/\s+/u);
  };

  const infra = command("tools/region-import/germany/build-germany-release.mjs");
  const capture = command("tools/tiles/build-map-source-capture.mjs");
  const sources = command("tools/tiles/static-map-sources-cli.mjs");
  const map = command("tools/tiles/build-map-release.mjs");

  assert.deepEqual(infra, [
    "node",
    "tools/region-import/germany/build-germany-release.mjs",
    "manifest",
    "tools/region-import/germany/release.annual-2026.3.config.json",
    "tools/region-import/germany/source-catalog.json",
    "tools/guards/quellenregister.json",
    "var/derived/germany-2026.3/source-capture.2026.3.json",
    "var/derived/germany-2026.3/release-artifacts.v2.json",
    "var/derived/germany-2026.3/map-release-free-v2/public/static-map-quality-v2.json",
    "var/derived/germany-2026.3/operational-infrastructure-quality.json",
    "var/derived/germany-2026.3/map-release-free-v2/public/infra-release.json",
  ]);
  assert.deepEqual(capture, [
    "node",
    "tools/tiles/build-map-source-capture.mjs",
    "var/source-cache/annual-2026-pinned/protomaps-dark-upstream-2026-08-12-08a5067f9cc54b1068e0e3cb830d9c51a6c8375be03ebea6acc7108d8d61d2df.json",
    "var/source-cache/annual-2026-pinned/welt-mit-deutschland-detail-2026-08-12-8a5a34b8586ef55313370a8dfc7143f80e9c5e85fb1af5c5dfc2eb68e22c658b.metadata.json",
    "var/source-cache/annual-2026-pinned/welt-mit-deutschland-detail-2026-08-12-c766073e55b99b213276328e504cbb7a69b0b65db0546adf484539c3bd319aed.pmtiles",
    "var/derived/germany-2026.3/map-release-free-v2/infra-deutschland-2026.3.pmtiles",
    "var/derived/germany-2026.3/map-release-free-v2/public/infra-release.json",
    "tools/tiles/map-asset-notices.annual-2026.3.json",
    ".",
    "tools/tiles/map-build-cache-inventory.annual-2026.3.plan.json",
    ".",
    "var/derived/germany-2026.3/map-release-free-v2/public/map-source-capture.json",
  ]);
  assert.deepEqual(sources, [
    "node",
    "tools/tiles/static-map-sources-cli.mjs",
    "materialize",
    "tools/tiles/static-map-sources.annual-2026.3.json",
    "tools/region-import/germany/source-catalog.json",
    "var/derived/germany-2026.3/source-capture.2026.3.json",
    "tools/tiles/map-source-catalog.json",
    "var/derived/germany-2026.3/map-release-free-v2/public/map-source-capture.json",
    "tools/guards/quellenregister.json",
    "tools/tiles/map-asset-notices.annual-2026.3.json",
    ".",
    "var/derived/germany-2026.3/map-release-free-v2/public/static-map-sources-v2.json",
  ]);
  assert.deepEqual(map, [
    "node",
    "tools/tiles/build-map-release.mjs",
    "tools/tiles/map-release.annual-2026.3.spec.json",
    ".",
    "tools/tiles/map-source-catalog.json",
    "var/derived/germany-2026.3/map-release-free-v2/public/map-source-capture.json",
    "tools/guards/quellenregister.json",
    "var/derived/germany-2026.3/map-release-free-v2/public/map-release.json",
  ]);

  const infraIndex = documentation.indexOf(infra.join(" "));
  const captureIndex = documentation.indexOf(capture.join(" "));
  const sourcesIndex = documentation.indexOf(sources.join(" "));
  const mapIndex = documentation.indexOf(map.join(" "));
  assert.ok(infraIndex >= 0 && infraIndex < captureIndex);
  assert.ok(captureIndex < sourcesIndex && sourcesIndex < mapIndex);
  assert.match(documentation, /zugfolge-map-source-capture\/v2/u);
  assert.match(documentation, /zugfolge-static-map-sources\/v3/u);
  assert.match(documentation, /historisch[\s\S]*abgelöst/u);
  assert.match(documentation, /aktu(?:elle|eller)[\s\S]*kartenrelease-deutschland-2026\.4-v2\.md/u);
  assert.match(documentation, /nie[\s\S]{0,100}(?:produktiv )?aktiviert/u);
  assert.doesNotMatch(documentation, /basemap-source-capture-2026-08-12\.json[^`]/u);
});

test("aktueller 900-MiB-Kandidat und archivierter >1-GiB-Robustheitspfad bleiben getrennt", async () => {
  const [rustRealTest, readiness, mapRunbook, ci] = await Promise.all([
    text("crates/zugfolge-infra/tests/operational_streaming_real.rs"),
    text("docs/infrarelease-deutschland-2026.4-readiness.md"),
    text("docs/kartenrelease-deutschland-2026.4-v2.md"),
    text(".github/workflows/ci.yml"),
  ]);

  assert.match(rustRealTest, /CURRENT_2026_4_CONTRACT[\s\S]*expected_source_bytes: 983_736_272[\s\S]*minimum_source_bytes: MINIMUM_CURRENT_2026_4_CORPUS_BYTES/u);
  assert.match(rustRealTest, /ARCHIVED_2026_3_OVER_ONE_GIB_CONTRACT[\s\S]*expected_source_bytes: 1_485_411_153[\s\S]*minimum_source_bytes: MINIMUM_OVER_ONE_GIB_CORPUS_BYTES/u);
  assert.match(rustRealTest, /89a2584b9eec170b7b12797611f72d77008f839453fac64969d8744345c0ec3e/u);
  assert.match(rustRealTest, /6f8a0c2368e732a4decdf4d2b61d4bca58eb91530b92f36ce8e9c777c691b5ed/u);
  assert.equal((rustRealTest.match(/fn run_real_corpus\(/gu) ?? []).length, 1);
  assert.match(rustRealTest, /fn realer_korpus_ab_900_mib_bleibt_unter_fester_rss_grenze\(\)[\s\S]{0,120}run_real_corpus\(CURRENT_2026_4_CONTRACT\)/u);
  assert.match(rustRealTest, /fn archivierter_2026_3_korpus_ueber_1_gib_bleibt_unter_fester_rss_grenze\(\)[\s\S]{0,120}run_real_corpus\(ARCHIVED_2026_3_OVER_ONE_GIB_CONTRACT\)/u);
  assert.match(ci, /--exact realer_korpus_ab_900_mib_bleibt_unter_fester_rss_grenze/u);
  assert.doesNotMatch(ci, /--exact archivierter_2026_3_korpus_ueber_1_gib_bleibt_unter_fester_rss_grenze/u);

  for (const documentation of [readiness, mapRunbook]) {
    assert.match(documentation, /983\.736\.272/u);
    assert.match(documentation, /mindestens\s+900 MiB/u);
    assert.match(documentation, /archiviert(?:e|en)[\s\S]{0,240}1\.455\.920\.792/u);
    assert.match(documentation, /64bcc5a750c0667526baf95a5ae8f9fa9c6ff64e63b24462090cc1c36c6abb4c/u);
    assert.match(documentation, /5972ef9d4897e5dc225ff463620745913846a6b16dba813f5fd12598c768399f/u);
    assert.match(documentation, /1\.485\.411\.153/u);
    assert.match(documentation, /89a2584b9eec170b7b12797611f72d77008f839453fac64969d8744345c0ec3e/u);
    assert.match(documentation, /9e378f65b528699609312e792965d9deb52276c12198609bb005b3356fe7d1bb/u);
    assert.match(documentation, /6f8a0c2368e732a4decdf4d2b61d4bca58eb91530b92f36ce8e9c777c691b5ed/u);
    assert.match(documentation, /Migration und native[\s\S]{0,80}Validierung sind bestanden/u);
    assert.match(documentation, /(?:Linux-cgroup-v2-RSS-Lauf|>1-GiB-RSS-Realtest)[\s\S]{0,200}bestanden/u);
    assert.match(documentation, /49\.147\.904 Bytes Prozess-Peak-RSS/u);
    assert.match(documentation, /nicht aktivierbar/u);
  }
  assert.match(readiness, /--exact archivierter_2026_3_korpus_ueber_1_gib_bleibt_unter_fester_rss_grenze/u);
  assert.match(readiness, /ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_RSS_PROOF_OUTPUT/u);
  assert.match(readiness, /migrate-operational-v2-protection-fields\.mjs[\s\S]{0,320}protection-fields-v2\/operational-infrastructure-v2\.json/u);
  assert.match(readiness, /--expected-source-bytes 1455920792[\s\S]{0,160}--expected-source-sha256 64bcc5a750c0667526baf95a5ae8f9fa9c6ff64e63b24462090cc1c36c6abb4c/u);
  assert.match(readiness, /--expected-replacements 644900[\s\S]{0,160}--expected-generic-etcs-dropped 25321[\s\S]{0,160}--expected-pzb-fallback-applied 368/u);
  assert.match(readiness, /ARCHIVED_2026_3_EXPECTED_BYTES=1485411153/u);
  assert.match(readiness, /ARCHIVED_2026_3_EXPECTED_SOURCE_SHA256=89a2584b9eec170b7b12797611f72d77008f839453fac64969d8744345c0ec3e/u);
  assert.match(readiness, /ARCHIVED_2026_3_EXPECTED_STATE_HASH=6f8a0c2368e732a4decdf4d2b61d4bca58eb91530b92f36ce8e9c777c691b5ed/u);
  assert.match(readiness, /f7990fc4317f170cfe79618842b45bd504f3b08311e3497c928aff7387de3fb2/u);
  assert.match(readiness, /memory\.max` an 536\.870\.912 Bytes[\s\S]{0,80}memory\.swap\.max` an 0/u);
  assert.doesNotMatch(readiness, /MIGRATED_(?:OUTPUT|NATIVE)_/u);
  assert.match(readiness, /25\.321[\s\S]{0,240}368[\s\S]{0,320}defaultProtectionSystem=pzb/u);
  assert.match(readiness, /Vor dem atomaren Link[\s\S]{0,120}aktuelle native Loader/u);
  assert.match(readiness, /keine Laufzeitkompatibilität/u);
  assert.match(rustRealTest, /requiredProtectionSystems[\s\S]{0,720}Migration und[\s\S]{0,80}native Validierung sind bestanden/u);
  assert.match(rustRealTest, /25\.321 generische[\s\S]{0,180}PZB-Fallback[\s\S]{0,80}368/u);
  assert.match(rustRealTest, /Legacy-Byte-\/SHA-Pins[\s\S]{0,100}CLI-Zaehler[\s\S]{0,100}native Validator/u);
});

test("2026.4-Dokumente und Real-Audits enthalten keine verworfenen oder ueberzogenen Ergebnisbindungen", async () => {
  const [readiness, mapRunbook, signedStagingAudit, runtimeAudit, ci] = await Promise.all([
    text("docs/infrarelease-deutschland-2026.4-readiness.md"),
    text("docs/kartenrelease-deutschland-2026.4-v2.md"),
    text("tools/audits/germany-2026.4-signed-game-staging.real.test.mjs"),
    text("tools/audits/germany-2026.4-alpha-world-runtime.real.test.mjs"),
    text(".github/workflows/ci.yml"),
  ]);
  for (const documentation of [readiness, mapRunbook]) {
    assert.match(documentation, /64260fb3aca24d6ed8784c2a6891e1269b8f390c7b7db185bbee3001565f47e6/u);
    assert.match(documentation, /deb038434d53963ba6436d4b6811ffc096374ffd1c75887b4945b4a46ea3c788/u);
    assert.match(documentation, /08c15a206f643d904151f50b6697c8e691329839a97baf0582c3d07586c60da7/u);
    assert.match(documentation, /d181d47a6ee09e9e462e440f4fba7e732130854d34fabdc19f910c66f70cb709/u);
    assert.match(documentation, /b773792afbe1bc4d487e3465f02f415d2e1fe9137559d4560ff785c3f6f74d1b/u);
    assert.match(documentation, /2540fcc5eedf7f6a76283d2922ff31d3d244d3bfb5dd15da9af92f05fa78628d/u);
    assert.doesNotMatch(documentation, /f118cee9211a5e0a725d6fcbaab4eac84179d7218e12ed9d3810a9dc848c0fde/u);
    assert.doesNotMatch(documentation, /338f57829a88209249125e73cc10bdd88b1c7453d3304472359a5f7790b02090/u);
    assert.doesNotMatch(documentation, /e42d190811a00f615ed7be20d97b2201e696148915aedd0bd8ba8401fd33d67e/u);
    assert.doesNotMatch(documentation, /d0f1b0034407d2fc1f0e377deba0677c5182b9cbf18c624981b35ccbd3f4e4ea/u);
  }
  assert.match(readiness, /Erstinstallation mit Status `installed` bestanden/u);
  assert.match(mapRunbook, /INFRA_OPERATIONAL_V2_VALIDATOR_PATH[\s\S]*germany-2026\.4-signed-game-staging\.real\.test\.mjs/u);
  assert.match(readiness, /infra-deutschland-2026\.3[\s\S]{0,80}unveränderlich verworfen/u);
  assert.match(mapRunbook, /infra-deutschland-2026\.3[\s\S]{0,80}unveränderlich/u);
  for (const documentation of [readiness, mapRunbook]) {
    assert.match(documentation, /91d13afbe78715a9a55758aaf549e4df777a69df15f87d4b430c2089e8451010/u);
    assert.match(documentation, /19eca1460912dcc004936e787041ae633e53cf9c1126dd7bbddace4ba636d4b8/u);
    assert.match(documentation, /zugfolge-map-runtime\/v1[\s\S]{0,100}(?:verworfen|dürfen weder)/u);
  }
  assert.doesNotMatch(signedStagingAudit, /e42d190811a00f615ed7be20d97b2201e696148915aedd0bd8ba8401fd33d67e/u);
  assert.match(signedStagingAudit, /ZUGFOLGE_REAL_SIGNED_MAP_EXPECTED_MANIFEST_SHA256/u);
  for (const documentation of [readiness, mapRunbook]) {
    assert.doesNotMatch(documentation, /PGlite/u);
    assert.match(documentation, /extern(?:es|en|er)[\s\S]{0,20}PostgreSQL/u);
    assert.match(documentation, /au.erhalb[\s\S]{0,80}App-cgroup/u);
    assert.match(documentation, /zehn|mindestens zehn/u);
  }
  assert.doesNotMatch(runtimeAudit, /pglite-local-integration-not-postgresql/u);
  assert.match(runtimeAudit, /external-postgresql-process-outside-measured-app-cgroup/u);
  assert.match(runtimeAudit, /exact-repository-journal-created-at-and-sql-sha256\/v1/u);
  assert.match(runtimeAudit, /freshDatabaseBeforeMutation: true/u);
  assert.match(runtimeAudit, /assertPostgresServerVersionNumber/u);
  assert.match(runtimeAudit, /assertNoCgroupOom\(cgroupMemoryEventsBefore/u);
  assert.match(runtimeAudit, /assertNoCgroupOom\(cgroupMemoryEventsAfter/u);
  assert.match(ci, /POSTGRES_DB: zugfolge_germany_e2e_ci/u);
  assert.match(ci, /- 5432\/tcp/u);
  assert.match(ci, /job\.services\.postgres\.ports\[5432\]/u);
  assert.doesNotMatch(ci, /55432:5432/u);
  assert.match(ci, /test -f "\$\{ZUGFOLGE_REAL_GERMANY_2026_4_ROOT\}\/alpha-world-build-configuration\.json"/u);
  assert.match(ci, /test -f "\$\{ZUGFOLGE_REAL_GERMANY_2026_4_ROOT\}\/timetable-routes-v2\.transfer-demands-v1\.json"/u);
  assert.match(ci, /test -f "\$\{ZUGFOLGE_REAL_GERMANY_2026_4_ROOT\}\/operational-infrastructure-v2\.movement-route-templates-v2\.json"/u);
  assert.match(ci, /ZUGFOLGE_REAL_GERMANY_POSTGRES_BOUNDARY: external-postgresql-process-outside-measured-app-cgroup/u);
  assert.match(ci, /MemoryMax=536870912[\s\S]*MemorySwapMax=0[\s\S]*ZUGFOLGE_REAL_GERMANY_POSTGRES_URL/u);
  assert.match(ci, /github\.event_name == 'workflow_dispatch'[\s\S]*run_germany_2026_4_real_acceptance == true/u);
  assert.match(ci, /ZUGFOLGE_REAL_GERMANY_REUSE_DEPLOYMENTS=1/u);
  assert.match(ci, /ZUGFOLGE_REAL_GERMANY_EXPECTED_UNSIGNED_DEPLOYMENT_SHA256=7400d56e2109db29050577c42a53f8e223325c4414c39b96cfcc9453f65eefba/u);
  assert.match(ci, /ZUGFOLGE_REAL_GERMANY_EXPECTED_SIGNED_DEPLOYMENT_SHA256=228d7c7cef743536f3b2621db200da898b4a1d30ec2cfe3b19d57fdea55c00c0/u);
  assert.match(ci, /ZUGFOLGE_REAL_GERMANY_EXPECTED_DEPLOYMENT_HASH=4d9627d85ceab1c893a0fe3366e4d5f14f6173c58e164728d92825b81eb87098/u);
  assert.match(ci, /ZUGFOLGE_REAL_GERMANY_EXPECTED_TYPESCRIPT_BUILD_SET_SHA256/u);
  assert.match(ci, /2540fcc5eedf7f6a76283d2922ff31d3d244d3bfb5dd15da9af92f05fa78628d/u);
  assert.match(ci, /--message-format=json-render-diagnostics[\s\S]*compiler-artifact[\s\S]*ZUGFOLGE_OPERATIONAL_STREAMING_REAL_BINARY/u);
  assert.doesNotMatch(ci, /find target\/release\/deps[\s\S]*operational_streaming_real/u);
  assert.match(runtimeAudit, /git-rev-parse-head-and-status-porcelain-including-untracked\/v1/u);
  assert.match(runtimeAudit, /zugfolge-germany-runtime-build-proof\/v1/u);
  assert.match(runtimeAudit, /ZUGFOLGE_REAL_GERMANY_EXPECTED_TYPESCRIPT_BUILD_SET_SHA256/u);
  assert.match(runtimeAudit, /2540fcc5eedf7f6a76283d2922ff31d3d244d3bfb5dd15da9af92f05fa78628d/u);
  assert.match(runtimeAudit, /zugfolge-germany-alpha-release-candidate-proof\/v1/u);
  assert.doesNotMatch(runtimeAudit, /releaseBoundAlphaWorldBuilderInputs/u);
  assert.doesNotMatch(runtimeAudit, /builderSidecars: builderInputs\.sidecars/u);
  assert.match(runtimeAudit, /acceptanceEligible: acceptance\.eligible/u);
  assert.match(runtimeAudit, /unsignedDocument\.deployment[\s\S]*signedDocument\.deployment/u);
  assert.match(runtimeAudit, /ten-consecutive-realtime-intervals/u);
  assert.match(runtimeAudit, /expectedRealtimeRegions/u);
  assert.match(runtimeAudit, /livemap_fresh/u);
  assert.match(runtimeAudit, /batchStartedCommandCount/u);
  assert.match(runtimeAudit, /batchCompletedCommandCount/u);
  assert.match(runtimeAudit, /zugfolge-germany-rendered-authority-proof\/v1/u);
  assert.match(runtimeAudit, /after-signed-deployment-parser-before-database-mutation/u);
  assert.match(runtimeAudit, /loadOperatingRuntime\(\)\.initializeFleet/u);
  assert.match(runtimeAudit, /parsePlanningInfrastructureRelease/u);
  assert.match(readiness, /availableProtectionSystems[\s\S]{0,240}simultaneouslyRequiredProtectionSystems/u);
  assert.match(readiness, /Schließungsevidence für #297/u);
});

test("versionierte Infra-, Map- und Alpha-Ausgaben sind create-new", async () => {
  const [rustCli, mapCli, alphaSigner] = await Promise.all([
    text("crates/zugfolge-infra/src/bin/zugfolge-infra-release.rs"),
    text("tools/tiles/build-map-release.mjs"),
    text("tools/alpha-ops/sign-alpha-deployment.mjs"),
  ]);
  assert.equal((rustCli.match(/write_json_new\(output, &release\)/gu) ?? []).length, 3);
  assert.doesNotMatch(rustCli, /write_json\(output, &release\)/u);
  assert.match(mapCli, /flag:\s*"wx"/u);
  assert.match(alphaSigner, /INPUT PRIVATE_KEY KEY_ID OUTPUT/u);
  assert.match(alphaSigner, /separates create-new Ziel/u);
  assert.match(alphaSigner, /flag:\s*"wx"/u);
});

test("2026.3 enthält nur echte Altquellenbelege und keine erfundenen Ergebnis-Hashes", async () => {
  const [mapPackage, buildEvidence] = await Promise.all([
    json("tools/tiles/map-package.annual-2026.3.plan.json"),
    json("tools/tiles/map-release-build-evidence.annual-2026.3.spec.json"),
  ]);
  const derivedDescriptors = [
    ...mapPackage.artifacts,
    ...mapPackage.auxiliaryFiles,
    ...buildEvidence.inputs,
    ...buildEvidence.outputs,
  ].filter((descriptor) => `${descriptor.sourceFile ?? descriptor.file ?? ""}`.includes("2026.3"));
  for (const descriptor of derivedDescriptors) {
    if (descriptor.id === "gtfs-region-snapshot") {
      assert.equal(descriptor.expectedBytes, 14797184);
      assert.equal(descriptor.expectedSha256, "cbebbcb73e1807df793c26411873b2df442e6ce38d28fd0593a78e5ae93912c5");
      continue;
    }
    assert.equal(Object.hasOwn(descriptor, "expectedBytes"), false, `${descriptor.id} besitzt eine erfundene Bytezahl.`);
    assert.equal(Object.hasOwn(descriptor, "expectedSha256"), false, `${descriptor.id} besitzt einen erfundenen SHA-256.`);
    assert.equal(Object.hasOwn(descriptor, "stateHash"), false, `${descriptor.id} besitzt einen erfundenen Zustandshash.`);
  }

  const pinnedBasemap = mapPackage.artifacts.find(({ kind }) => kind === "basemap");
  assert.equal(pinnedBasemap.expectedSha256, "c766073e55b99b213276328e504cbb7a69b0b65db0546adf484539c3bd319aed");
  assert.equal(pinnedBasemap.sourceFile.includes(pinnedBasemap.expectedSha256), true);
});

test("der ergänzende Source-Audit verweist nicht mehr auf 2026.2-Layer", async () => {
  const compiler = await json("tools/region-import/germany/operational-source-compiler.annual-2026.3.json");
  assert.equal(compiler.infraReleaseId, "infra-deutschland-2026.3");
  for (const path of [...Object.values(compiler.layers), compiler.eboStopPositions]) {
    assert.match(path, /germany-2026\.3/u);
    assert.doesNotMatch(path, /germany-2026\.2/u);
  }
});

test("Jahresprompt verlangt alle fünfundvierzig konkreten Platzhalter und den integrierten V2-Jahresvertrag in den Befehlen", async () => {
  const prompt = await text("docs/prompts/infrarelease-deutschland-jahreslauf.md");
  const expected = [
    "ANNUAL_ARTIFACT_SPEC",
    "ANNUAL_RELEASE_CONFIG",
    "ARTEFAKTWURZEL",
    "BUILD_EVIDENCE_SPEC",
    "DELIVERY_KEY_ID",
    "FAHRPLANJAHR",
    "GDAL_RUNTIME_MANIFEST",
    "INFRARELEASE_ID",
    "MAP_ASSET_NOTICES_SPEC",
    "MAP_PACKAGE_PLAN",
    "OPERATIONAL_ANNUAL_PLAN",
    "OPERATIONAL_ANNUAL_START_EVIDENCE",
    "OPERATIONAL_ARTIFACT_ID",
    "OPERATIONAL_ATTESTATION_TRUSTED_ROOT",
    "OPERATIONAL_ATTESTATION_VERIFIER",
    "OPERATIONAL_CANDIDATE",
    "OPERATIONAL_CANDIDATE_SIDECAR",
    "OPERATIONAL_DERIVER_OUTPUT",
    "OPERATIONAL_DERIVER_REPORT",
    "OPERATIONAL_DERIVER_SPECIFICATION",
    "OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT",
    "OPERATIONAL_EXECUTION_AUTHORITY_BUNDLE",
    "OPERATIONAL_EXECUTION_PINS",
    "OPERATIONAL_LAUNCH_CONTEXT",
    "OPERATIONAL_NATIVE_RECEIPT",
    "OPERATIONAL_OUTER_EXECUTION_RECEIPT",
    "OPERATIONAL_PUBLICATION_RECEIPT",
    "OPERATIONAL_QUALITY_SPEC",
    "OPERATIONAL_REBUILD_ATTESTATION_BUNDLE",
    "OPERATIONAL_VALIDATOR_BUILD_COMMIT",
    "OPERATIONAL_VALIDATOR_PATH",
    "OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE",
    "OPERATIONAL_VALIDATOR_REBUILD_SPEC",
    "PINNED_ZUGFOLGE_INFRA_RELEASE",
    "QUELLWURZEL",
    "RELEASE_ARTIFACT_INVENTORY",
    "RIGHTS_LEDGER",
    "SEMANTIC_PMTILES_OUTPUT",
    "SEMANTIC_TILE_INPUTS",
    "SEMANTIC_TILE_INPUT_ROOT",
    "SOURCE_CAPTURE_MANIFEST",
    "SOURCE_CATALOG",
    "STICHTAG_UTC",
    "SYNTHETIC_CLOSURE_SPEC",
    "TIMETABLE_ROUTE_SPEC",
  ];
  const actual = [...new Set([...prompt.matchAll(/<([A-Z_]+)>/gu)].map(([, name]) => name))].sort();
  assert.deepEqual(actual, expected);
  assert.doesNotMatch(prompt, /tools\/region-import\/germany\/release\.config\.json/u);
  assert.match(prompt, /build-germany-release\.mjs compile <ANNUAL_RELEASE_CONFIG>/u);
  assert.match(prompt, /build-germany-release\.mjs manifest <ANNUAL_RELEASE_CONFIG>/u);
  assert.doesNotMatch(prompt, /node tools\/region-import\/germany\/run-capture-operational-infrastructure-v2\.mjs/u);
  assert.match(prompt, /primaryRunnerMode` muss exakt[\s\S]*`system-launcher-held-bundle-stdin-v1/u);
  assert.match(prompt, /systemCommandBuilderMode` muss exakt[\s\S]*`source-only-print-direct-command-v1/u);
  assert.match(prompt, /\.github\/workflows\/operational-validator-rebuild-evidence\.yml[\s\S]*GitHub-hosted Windows-Runner/u);
  assert.match(prompt, /Node-24-Runtime create-new als[\s\S]*<ARTEFAKTWURZEL>\/toolchain\/nodejs-24-operational-runner-v1\.exe[\s\S]*portablen repositoryrelativen Pfad/u);
  assert.doesNotMatch(prompt, /kanonischen absoluten Pfad der gepinnten Node-24-Runtime/u);
  assert.match(prompt, /& "\.\\<ARTEFAKTWURZEL>\\toolchain\\nodejs-24-operational-runner-v1\.exe" tools\/region-import\/germany\/run-operational-infrastructure-v2-annual-execution\.mjs execute <OPERATIONAL_EXECUTION_PINS> <OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT> <ANNUAL_RELEASE_CONFIG> <SOURCE_CATALOG> <RIGHTS_LEDGER> <OPERATIONAL_LAUNCH_CONTEXT> <OPERATIONAL_ANNUAL_PLAN> <OPERATIONAL_ANNUAL_START_EVIDENCE> <OPERATIONAL_OUTER_EXECUTION_RECEIPT>/u);
  assert.doesNotMatch(prompt, /(?:^|\n)\s*node tools\/region-import\/germany\/run-operational-infrastructure-v2-annual-execution\.mjs/u);
  assert.match(prompt, /build-map-delivery-release\.mjs <MAP_PACKAGE_PLAN>[\s\S]*"\$MAP_BUILD_COMMIT"[\s\S]*delivery-unsigned/u);
  assert.match(prompt, /sign-map-delivery-release\.mjs <MAP_PACKAGE_PLAN>[\s\S]*"\$DELIVERY_KEY_ID" "\$MAP_BUILD_COMMIT"[\s\S]*public\/release\.json/u);
  assert.match(prompt, /signed-map-package-plan-cli\.mjs <MAP_PACKAGE_PLAN>[\s\S]*trusted-delivery-key-scopes\.json "\$MAP_BUILD_COMMIT"[\s\S]*signed-package-plan\.json/u);
  const trustPreparationIndex = prompt.indexOf("Vor Phase 1 und vor dem Merge");
  const phaseOneIndex = prompt.indexOf("Phase 1 ist");
  const signatureIndex = prompt.indexOf("Signiere erst dann Delivery-v2");
  assert.ok(trustPreparationIndex >= 0 && trustPreparationIndex < phaseOneIndex);
  assert.ok(phaseOneIndex < signatureIndex);
  assert.match(prompt, /Registrierung ist noch[\s\S]*keine Delivery-Signatur/u);
  assert.match(prompt, /bereits im selben geschützten[\s\S]*Commit registrierte öffentliche PEM-Datei/u);
  assert.doesNotMatch(prompt, /Signatur zunächst[\s\S]*Ergänze danach \$DELIVERY_KEY_ID/u);
  assert.match(prompt, /\.github\/workflows\/operational-v2-execution-authority\.yml[\s\S]*`operational-release-approval`[\s\S]*operator-approved-hash-binding-not-source-reexecution-v1/u);
  assert.match(prompt, /<OPERATIONAL_ATTESTATION_VERIFIER>[\s\S]*<OPERATIONAL_ATTESTATION_TRUSTED_ROOT>/u);
  assert.match(prompt, /publish-operational-infrastructure-v2\.mjs publish[\s\S]*<OPERATIONAL_NATIVE_RECEIPT> <OPERATIONAL_OUTER_EXECUTION_RECEIPT> <OPERATIONAL_VALIDATOR_REBUILD_SPEC>[\s\S]*<OPERATIONAL_PUBLICATION_RECEIPT>/u);
  assert.match(prompt, /forensic-stdin-v1[\s\S]*releaseEvidenceEligible=false[\s\S]*productionActivationEligible=false[\s\S]*executionProof=null/u);
  assert.match(prompt, /build-gdal-semantic-pmtiles\.mjs <SEMANTIC_TILE_INPUTS> <SEMANTIC_TILE_INPUT_ROOT> <SEMANTIC_PMTILES_OUTPUT> <GDAL_RUNTIME_MANIFEST> \./u);
  assert.match(prompt, /deterministic-conservative-v1/u);
  assert.match(prompt, /synthetic-operational-b\/v2/u);
  assert.match(prompt, /timetableRoutes.*TIMETABLE_ROUTE_OUTPUT/su);
  assert.match(prompt, /unresolvedRequired=0.*activationEligible=true/su);
  assert.match(prompt, /readiness-only.*Status 2.*candidateProduced=false.*unresolvedRequired=10/su);
  assert.match(prompt, /docs\/betriebsengine-lastnachweis\.md/u);
  assert.match(prompt, /osm-planet-basemap.*protomaps-daily-basemap/su);
  assert.match(prompt, /OpenRailwayMap(?: \(ORM\))?.*keine ORM-Daten/su);
  assert.match(prompt, /JourneyChain.*PlayableLeg.*BoundaryPortal.*ExternalLeg/su);
  assert.match(prompt, /5\.000 Ereignisse\/s über zehn Minuten/su);
  assert.match(prompt, /zugfolge-germany-timetable-route-compiler\/v5/u);
  assert.match(prompt, /zugfolge-germany-timetable-route-report\/v4/u);
  assert.match(prompt, /zugfolge-daily-circulation-plan\/v2/u);
  assert.match(prompt, /kind=timetable-transfer-demands-v2/u);
  assert.match(prompt, /timetable-routes-v2\.transfer-demands-v2\.json/u);
  assert.match(prompt, /erwarteten Mengen, Bytezahlen und SHA-256-Werte ausschließlich[\s\S]*<TIMETABLE_ROUTE_SPEC>/u);
  assert.doesNotMatch(prompt, /timetable-transfer-demands-v1|transfer-demands-v1\.json/u);
  assert.doesNotMatch(prompt, /infra-deutschland-20\d{2}\.\d+|germany-20\d{2}\.\d+|annual-20\d{2}\.\d+/u);
  assert.doesNotMatch(prompt, /\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/u);
});

test("aktuelle Datengrenze und Installationsanleitung verlangen den 2026.5-V2-Upstream ohne Laufzeitfallback", async () => {
  const [dataContract, installation] = await Promise.all([
    text("docs/daten.md"),
    text("docs/kartenartefakte-installation.md"),
  ]);
  for (const documentation of [dataContract, installation]) {
    assert.match(documentation, /timetable-transfer-demands-v2/u);
    assert.match(documentation, /1\.595\s+Turnarounds[\s\S]*82/u);
    assert.match(documentation, /historisch/u);
    assert.match(documentation, /kein(?:en)?[\s\S]{0,10}Fallback|nicht als Fallback/u);
  }
  assert.match(dataContract, /zugfolge-daily-circulation-plan\/v2/u);
  assert.match(dataContract, /1\.677 geplanten Übergängen/u);
  assert.match(installation, /Compiler v5 erzeugt den Bericht v4/u);
  assert.match(installation, /timetable-routes-v2\.transfer-demands-v2\.json/u);
  assert.match(installation, /6\.697\.294[\s\S]*2c8c688a9ce963afbdca75fee526b581bc21be402aabcbaf1abd09ea65418cdf/u);
});

test("Jahresprompt löst den aktuellen V2-Vertrag vollständig auf und lässt Vorgängerpfade nur im Evidence-Vertrag zu", async () => {
  const [
    prompt,
    releaseConfig,
    timetableRouteSpec,
    closureSpec,
    operationalQualitySpec,
    sourceCapturePlan,
    artifactSpec,
    mapPackagePlan,
    buildEvidence,
    executionPins,
    rebuildSpecification,
  ] = await Promise.all([
    text("docs/prompts/infrarelease-deutschland-jahreslauf.md"),
    json("tools/region-import/germany/release.annual-2026.5.config.json"),
    json("tools/region-import/germany/timetable-route-compiler.annual-2026.5.json"),
    json("tools/region-import/germany/synthetic-operational-closure.annual-2026.5.json"),
    json("tools/region-import/germany/operational-quality.annual-2026.5.json"),
    json("tools/region-import/germany/source-capture.annual-2026.5.plan.json"),
    json("tools/region-import/germany/release-artifacts.annual-2026.5.json"),
    json("tools/tiles/map-package.annual-2026.5.plan.json"),
    json("tools/tiles/map-release-build-evidence.annual-2026.5.spec.json"),
    json("tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json"),
    json("tools/region-import/germany/operational-validator-rebuild.annual-2026.5.json"),
  ]);
  const releaseId = releaseConfig.release.releaseId;
  const timetableYear = releaseConfig.release.timetableYear;
  const version = releaseId.replace(/^infra-deutschland-/u, "");
  const artifactRoot = `var/derived/germany-${version}`;
  const operationalDeriver = releaseConfig.pipeline.operationalDeriver;
  const recoveryPublisher = operationalDeriver.recoveryPublisher;
  const operationalArtifact = artifactSpec.artifacts.find(({ kind }) => kind === "operational-infrastructure-v2");
  const semanticAssembly = buildEvidence.inputs.find(({ id }) => id === "semantic-tile-assembly-spec");
  const semanticInputs = semanticAssembly.reuse.artifacts.find(({ targetFile }) => targetFile.endsWith("/inputs.json")).targetFile;
  const semanticInputRoot = semanticInputs.replace(/\/inputs\.json$/u, "");
  const semanticOutput = buildEvidence.outputs.find(({ id }) => id === "semantic-pmtiles").file;
  const assetNotices = buildEvidence.inputs.find(({ id }) => id === "map-asset-notices-spec").file;
  const gdalRuntime = buildEvidence.tools.find(({ id }) => id === "gdal-pmtiles").manifestFile;
  const evidenceInputFile = (id) => buildEvidence.inputs.find((input) => input.id === id).file;
  const annualExecutorPlan = rebuildSpecification.authority.annualExecutorPlan;
  const bindings = {
    ANNUAL_ARTIFACT_SPEC: "tools/region-import/germany/release-artifacts.annual-2026.5.json",
    ANNUAL_RELEASE_CONFIG: "tools/region-import/germany/release.annual-2026.5.config.json",
    ARTEFAKTWURZEL: artifactRoot,
    BUILD_EVIDENCE_SPEC: "tools/tiles/map-release-build-evidence.annual-2026.5.spec.json",
    DELIVERY_KEY_ID: `zugfolge-map-deutschland-${version}`,
    FAHRPLANJAHR: String(timetableYear),
    GDAL_RUNTIME_MANIFEST: gdalRuntime,
    INFRARELEASE_ID: releaseId,
    MAP_ASSET_NOTICES_SPEC: assetNotices,
    MAP_PACKAGE_PLAN: "tools/tiles/map-package.annual-2026.5.plan.json",
    OPERATIONAL_ANNUAL_PLAN: annualExecutorPlan.planFile,
    OPERATIONAL_ANNUAL_START_EVIDENCE: annualExecutorPlan.startEvidenceFile,
    OPERATIONAL_ARTIFACT_ID: operationalArtifact.id,
    OPERATIONAL_ATTESTATION_TRUSTED_ROOT: evidenceInputFile("operational-attestation-trusted-root"),
    OPERATIONAL_ATTESTATION_VERIFIER: evidenceInputFile("operational-attestation-verifier"),
    OPERATIONAL_CANDIDATE: operationalDeriver.candidate,
    OPERATIONAL_CANDIDATE_SIDECAR: operationalDeriver.candidateMovementRouteTemplates,
    OPERATIONAL_DERIVER_OUTPUT: operationalDeriver.output,
    OPERATIONAL_DERIVER_REPORT: operationalDeriver.report,
    OPERATIONAL_DERIVER_SPECIFICATION: operationalDeriver.specification,
    OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT: operationalDeriver.directSystemLaunch.contract.file,
    OPERATIONAL_EXECUTION_AUTHORITY_BUNDLE: evidenceInputFile("operational-execution-authority-attestation"),
    OPERATIONAL_EXECUTION_PINS: operationalDeriver.executionPins,
    OPERATIONAL_LAUNCH_CONTEXT: `${artifactRoot}/operational-infrastructure-v2.launch-context.json`,
    OPERATIONAL_NATIVE_RECEIPT: recoveryPublisher.nativeReceipt,
    OPERATIONAL_OUTER_EXECUTION_RECEIPT: recoveryPublisher.outerExecutionReceipt,
    OPERATIONAL_PUBLICATION_RECEIPT: recoveryPublisher.publicationReceipt,
    OPERATIONAL_QUALITY_SPEC: "tools/region-import/germany/operational-quality.annual-2026.5.json",
    OPERATIONAL_REBUILD_ATTESTATION_BUNDLE: evidenceInputFile("operational-validator-rebuild-attestation"),
    OPERATIONAL_VALIDATOR_BUILD_COMMIT: recoveryPublisher.validatorBuildCommit,
    OPERATIONAL_VALIDATOR_PATH: recoveryPublisher.validatorExecutable,
    OPERATIONAL_VALIDATOR_REBUILD_EVIDENCE: recoveryPublisher.validatorRebuildEvidence,
    OPERATIONAL_VALIDATOR_REBUILD_SPEC: recoveryPublisher.validatorRebuildSpecification,
    PINNED_ZUGFOLGE_INFRA_RELEASE: recoveryPublisher.validatorExecutable,
    QUELLWURZEL: "var/source-cache",
    RELEASE_ARTIFACT_INVENTORY: `${artifactRoot}/release-artifacts.v2.json`,
    RIGHTS_LEDGER: annualExecutorPlan.arguments[3],
    SEMANTIC_PMTILES_OUTPUT: semanticOutput,
    SEMANTIC_TILE_INPUT_ROOT: semanticInputRoot,
    SEMANTIC_TILE_INPUTS: semanticInputs,
    SOURCE_CAPTURE_MANIFEST: `${artifactRoot}/source-capture.${version}.json`,
    SOURCE_CATALOG: annualExecutorPlan.arguments[2],
    STICHTAG_UTC: sourceCapturePlan.notBefore,
    SYNTHETIC_CLOSURE_SPEC: "tools/region-import/germany/synthetic-operational-closure.annual-2026.5.json",
    TIMETABLE_ROUTE_SPEC: "tools/region-import/germany/timetable-route-compiler.annual-2026.5.json",
  };

  const placeholder = /<([A-Z_]+)>/gu;
  const resolved = prompt.replace(placeholder, (match, name) => bindings[name] ?? match);
  assert.doesNotMatch(resolved, placeholder);
  assert.match(resolved, new RegExp(
    `nodejs-24-operational-runner-v1\\.exe" tools/region-import/germany/run-operational-infrastructure-v2-annual-execution\\.mjs execute ${bindings.OPERATIONAL_EXECUTION_PINS.replaceAll(".", "\\.")} ${bindings.OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT.replaceAll(".", "\\.")} ${bindings.ANNUAL_RELEASE_CONFIG.replaceAll(".", "\\.")} ${bindings.SOURCE_CATALOG.replaceAll(".", "\\.")} ${bindings.RIGHTS_LEDGER.replaceAll(".", "\\.")} ${bindings.OPERATIONAL_LAUNCH_CONTEXT.replaceAll(".", "\\.")} ${bindings.OPERATIONAL_ANNUAL_PLAN.replaceAll(".", "\\.")} ${bindings.OPERATIONAL_ANNUAL_START_EVIDENCE.replaceAll(".", "\\.")} ${bindings.OPERATIONAL_OUTER_EXECUTION_RECEIPT.replaceAll(".", "\\.")}`,
    "u",
  ));
  assert.match(resolved, new RegExp(`publish-operational-infrastructure-v2\\.mjs publish[\\s\\S]*${bindings.OPERATIONAL_NATIVE_RECEIPT.replaceAll(".", "\\.")} ${bindings.OPERATIONAL_OUTER_EXECUTION_RECEIPT.replaceAll(".", "\\.")}[\\s\\S]*${bindings.OPERATIONAL_PUBLICATION_RECEIPT.replaceAll(".", "\\.")}`, "u"));
  assert.match(resolved, new RegExp(`build-gdal-semantic-pmtiles\\.mjs ${semanticInputs.replaceAll(".", "\\.")} ${semanticInputRoot.replaceAll(".", "\\.")} ${semanticOutput.replaceAll(".", "\\.")} ${gdalRuntime.replaceAll(".", "\\.")} \\.`, "u"));
  assert.match(resolved, /run-timetable-route-compiler\.mjs tools\/region-import\/germany\/timetable-route-compiler\.annual-2026\.5\.json \./u);
  assert.match(resolved, /run-synthetic-operational-closure\.mjs tools\/region-import\/germany\/synthetic-operational-closure\.annual-2026\.5\.json var\/derived\/germany-2026\.5\/synthetic-operational-closure-receipt\.json/u);
  assert.match(resolved, /run-operational-quality-report\.mjs tools\/region-import\/germany\/operational-quality\.annual-2026\.5\.json var\/derived\/germany-2026\.5\/operational-infrastructure-quality\.json/u);
  assert.match(resolved, /build-germany-release\.mjs manifest tools\/region-import\/germany\/release\.annual-2026\.5\.config\.json[\s\S]*var\/derived\/germany-2026\.5\/source-capture\.2026\.5\.json/u);
  assert.match(resolved, /signed-map-package-plan-cli\.mjs tools\/tiles\/map-package\.annual-2026\.5\.plan\.json \./u);

  assert.equal(operationalDeriver.primaryRunner, "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs");
  assert.equal(operationalDeriver.primaryRunnerMode, "system-launcher-held-bundle-stdin-v1");
  assert.equal(operationalDeriver.systemCommandBuilder, "tools/region-import/germany/print-operational-infrastructure-v2-system-launch-command.mjs");
  assert.equal(operationalDeriver.systemCommandBuilderMode, "source-only-print-direct-command-v1");
  assert.equal(executionPins.releaseId, releaseId);
  assert.equal(timetableRouteSpec.schema, "zugfolge-germany-timetable-route-compiler/v5");
  assert.equal(timetableRouteSpec.infraReleaseId, releaseId);
  assert.equal(timetableRouteSpec.output, `${artifactRoot}/timetable-routes-v2.jsonseq`);
  assert.equal(timetableRouteSpec.transferOutput, `${artifactRoot}/timetable-routes-v2.transfer-demands-v2.json`);
  assert.equal(timetableRouteSpec.report, `${artifactRoot}/timetable-routes-v2.derivation-report-v4.json`);
  assert.equal(closureSpec.schema, "zugfolge-synthetic-operational-closure-inputs/v2");
  assert.equal(closureSpec.releaseId, releaseId);
  assert.equal(closureSpec.artifactRoot, artifactRoot);
  assert.equal(operationalQualitySpec.schema, "zugfolge-operational-quality-inputs/v1");
  assert.equal(operationalQualitySpec.releaseId, releaseId);
  assert.equal(operationalQualitySpec.timetableYear, timetableYear);
  assert.equal(operationalQualitySpec.artifactRoot, artifactRoot);
  assert.equal(sourceCapturePlan.releaseId, releaseId);
  assert.equal(sourceCapturePlan.timetableYear, timetableYear);
  assert.equal(operationalArtifact.infraReleaseId, releaseId);
  assert.equal(operationalArtifact.sourceFile, `${artifactRoot}/operational-infrastructure-v2.json`);
  assert.equal(mapPackagePlan.schema, "zugfolge-map-package-plan/v2");
  assert.equal(mapPackagePlan.version, version);
  assert.equal(mapPackagePlan.runtime.schema, "zugfolge-map-runtime/v2");
  assert.equal(mapPackagePlan.runtime.publicBasePath, `/artifacts/maps/${releaseId}`);
  assert.equal(semanticAssembly.reuse.mode, "byte-identical-cross-release");
  assert.equal(semanticAssembly.reuse.targetReleaseId, releaseId);
  assert.notEqual(semanticAssembly.reuse.sourceReleaseId, releaseId);
});

test("Build-Evidence-v3 bindet alle tatsächlich verwendeten 2026.5-Spezifikationen und Repo-Verträge fail-closed", async () => {
  const specification = await json("tools/tiles/map-release-build-evidence.annual-2026.5.spec.json");
  assert.doesNotThrow(() => validateMapReleaseBuildEvidenceSpec(specification));
  const required = [
    "germany-release-spec",
    "synthetic-operational-policy",
    "synthetic-operational-closure-spec",
    "operational-quality-spec",
    "static-map-sources-spec",
    "static-map-quality-spec",
    "static-map-release-spec",
    "map-build-cache-inventory-plan",
    "map-asset-notices-spec",
    "operational-native-receipt",
    "operational-publication-receipt",
    "operational-native-receipt-capture",
    "operational-recovery-publisher",
    "operational-recovery-publisher-implementation",
    "operational-v2-deriver",
    "operational-v2-materializer",
    "create-new-output-contract",
    "operational-v2-binding",
    "operational-validator-rebuild-evidence",
    "operational-validator-rebuild-bootstrap",
    "operational-validator-rebuild-spec",
    "operational-validator-rebuild-verifier",
    "operational-validator-rebuild-cli",
    "germany-source-catalog",
    "rights-registry",
    "map-source-catalog",
  ];
  for (const id of required) {
    const missing = structuredClone(specification);
    missing.inputs = missing.inputs.filter((input) => input.id !== id);
    assert.throws(() => validateMapReleaseBuildEvidenceSpec(missing), new RegExp(id, "u"));
  }
  const wrongRepoKind = structuredClone(specification);
  wrongRepoKind.inputs.find(({ id }) => id === "rights-registry").kind = "specification";
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(wrongRepoKind), /rights-registry/u);
  const driftedPublisher = structuredClone(specification);
  driftedPublisher.inputs.find(({ id }) => id === "operational-recovery-publisher").file = "tools/region-import/germany/run-operational-infrastructure-v2.mjs";
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(driftedPublisher), /operational-recovery-publisher/u);
  const driftedReceipt = structuredClone(specification);
  driftedReceipt.inputs.find(({ id }) => id === "operational-publication-receipt").file = "var/derived/germany-2026.5/operational-infrastructure-v2.derivation-report.json";
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(driftedReceipt), /operational-publication-receipt/u);
  const driftedImplementation = structuredClone(specification);
  driftedImplementation.inputs.find(({ id }) => id === "operational-v2-materializer").file = "tools/region-import/germany/operational-infrastructure-v2.mjs";
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(driftedImplementation), /operational-v2-materializer/u);
  const driftedBinding = structuredClone(specification);
  driftedBinding.inputs.find(({ id }) => id === "operational-v2-binding").file = "tools/region-import/materialize-operational-infrastructure-v2.mjs";
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(driftedBinding), /operational-v2-binding/u);
  const driftedRebuildBootstrap = structuredClone(specification);
  driftedRebuildBootstrap.inputs.find(({ id }) => id === "operational-validator-rebuild-bootstrap").file = "tools/region-import/germany/operational-validator-rebuild-evidence.mjs";
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(driftedRebuildBootstrap), /operational-validator-rebuild-bootstrap/u);
  const wrongValidator = structuredClone(specification);
  wrongValidator.tools.find(({ id }) => id === "operational-v2-validator").file = "target/release/anderer-validator.exe";
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(wrongValidator), /Validator-Binary/u);
  const relabelledValidator = structuredClone(specification);
  relabelledValidator.tools.find(({ id }) => id === "operational-v2-validator").version = "map-build-commit";
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(relabelledValidator), /Validator-Binary/u);
  const driftedRebuild = structuredClone(specification);
  driftedRebuild.tools.find(({ id }) => id === "operational-v2-validator-rebuild").file = "target/release/unbound-rebuild.exe";
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(driftedRebuild), /Rebuild-Binary/u);
  const missingRuntime = structuredClone(specification);
  missingRuntime.tools = missingRuntime.tools.filter(({ id }) => id !== "gdal-pmtiles");
  assert.throws(() => validateMapReleaseBuildEvidenceSpec(missingRuntime), /manifestgebundenes gdal-pmtiles/u);
});

test("2026.5 trennt den primaeren Operational-v2-Runner vom receiptgebundenen RecoveryPublisher", async () => {
  const [releaseConfig, cachePlan] = await Promise.all([
    json("tools/region-import/germany/release.annual-2026.5.config.json"),
    json("tools/tiles/map-build-cache-inventory.annual-2026.5.plan.json"),
  ]);
  assert.deepEqual(releaseConfig.pipeline.operationalDeriver, {
    primaryRunner: "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs",
    primaryRunnerMode: "system-launcher-held-bundle-stdin-v1",
    systemCommandBuilder: "tools/region-import/germany/print-operational-infrastructure-v2-system-launch-command.mjs",
    systemCommandBuilderMode: "source-only-print-direct-command-v1",
    directSystemLaunch: {
      platform: "win32",
      contract: {
        file: "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json",
        bytes: 22_507,
        sha256: "49221adcfe62591037de63c2f3e63a3aaf3ef61a8bb723d67871b4bbf04848c0",
        schema: "zugfolge-operational-v2-direct-system-launch-contract/v1",
        releaseId: "infra-deutschland-2026.5",
        executionPins: {
          file: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
          bytes: 4_841,
          sha256: "59101e85fd7b203918874c25a33313fb719f47a672de7628519e3c02bcd81741",
          schema: "zugfolge-germany-operational-v2-execution-pins/v1",
        },
        trustedExecutor: {
          file: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe",
          buildCommit: "aba354ec1937452a491087626ec0adea36ef6695",
          bytes: 8_382_277,
          sha256: "c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4",
        },
      },
    },
    executionPins: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
    specification: "tools/region-import/germany/operational-infrastructure.annual-2026.5.json",
    sourceRoot: ".",
    candidate: "var/derived/germany-2026.5/operational-infrastructure-v2.candidate.json",
    candidateMovementRouteTemplates: "var/derived/germany-2026.5/operational-infrastructure-v2.candidate.movement-route-templates-v2.json",
    report: "var/derived/germany-2026.5/operational-infrastructure-v2.derivation-report.json",
    output: "var/derived/germany-2026.5/operational-infrastructure-v2.json",
    recoveryPublisher: {
      captureEntrypoint: "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs",
      entrypoint: "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
      validatorExecutable: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe",
      validatorBuildCommit: "aba354ec1937452a491087626ec0adea36ef6695",
      validatorBytes: 8_382_277,
      validatorSha256: "c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4",
      validatorRebuildSpecification: "tools/region-import/germany/operational-validator-rebuild.annual-2026.5.json",
      validatorRebuildEvidence: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json",
      validatorRebuildExecutable: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-aba354ec1937452a491087626ec0adea36ef6695-official.exe",
      validatorRebuildExpectedBytes: 8_382_277,
      validatorNormalizedPeSha256: "ae39f5a8378641be0d02be56e93bf585a49a6e65bc1f5a02b77cd2bd556d38cb",
      executionInventory: {
        wrapper: "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
        implementation: "tools/region-import/germany/operational-infrastructure-v2-publication.mjs",
        operationalDeriver: "tools/region-import/germany/operational-infrastructure-v2.mjs",
        materializer: "tools/region-import/materialize-operational-infrastructure-v2.mjs",
        createNewOutput: "tools/tiles/create-new-output.mjs",
        operationalBinding: "tools/region-import/operational-infrastructure-binding.mjs",
        validatorRebuildBootstrap: "tools/region-import/germany/operational-validator-rebuild-bootstrap.mjs",
        validatorRebuildVerifier: "tools/region-import/germany/operational-validator-rebuild-evidence.mjs",
        executionPinsImplementation: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.mjs",
        annualCreateNewArtifact: "tools/region-import/germany/annual-create-new-artifact.mjs",
        outerExecutionReceiptVerifier: "tools/region-import/germany/operational-infrastructure-v2-outer-execution-receipt.mjs",
      },
      nativeReceipt: "var/derived/germany-2026.5/operational-infrastructure-v2.native-receipt.json",
      outerExecutionReceipt: "var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json",
      publicationReceipt: "var/derived/germany-2026.5/operational-infrastructure-v2.publication-receipt.json",
    },
  });
  for (const file of [
    "operational-infrastructure-v2.native-receipt.json",
    "operational-infrastructure-v2.publication-receipt.json",
    "zugfolge-infra-release-rebuild-evidence.json",
    "zugfolge-infra-release-source-aba354ec1937452a491087626ec0adea36ef6695-3f267637dcd52dded45ca921d27863149b3fd2919b7bb2e9d881b381c04565af.tar",
    "zugfolge-infra-release-rebuild-provenance-aba354ec1937452a491087626ec0adea36ef6695.json",
  ]) {
    assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => sourceFile.endsWith(`/${file}`) && cacheFile.endsWith(`/${file}`)), `${file} fehlt im Buildcache-Inventar`);
  }
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe"
      && cacheFile === "tools/zugfolge-infra-release/infra-deutschland-2026.5/aba354ec1937452a491087626ec0adea36ef6695/c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4/zugfolge-infra-release.exe"
  )), "effektives Validator-Binary fehlt im Buildcache-Inventar");
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-aba354ec1937452a491087626ec0adea36ef6695-official.exe"
      && cacheFile === "tools/zugfolge-infra-release/infra-deutschland-2026.5/aba354ec1937452a491087626ec0adea36ef6695/official/zugfolge-infra-release.exe"
  )), "immutable Validator-Rebuild-Binary fehlt im Buildcache-Inventar");
});

test("2026.5 besitzt einen eigenen Asset-Notice-Vertrag und das vollständige GDAL-Runtime-Cachemapping", async () => {
  const [currentNotices, historicalNotices, evidence, manifest, cachePlan, prompt] = await Promise.all([
    json("tools/tiles/map-asset-notices.annual-2026.5.json"),
    json("tools/tiles/map-asset-notices.annual-2026.3.json"),
    json("tools/tiles/map-release-build-evidence.annual-2026.5.spec.json"),
    json("tools/tiles/gdal-runtime.3.13.2-win32-x64.manifest.json"),
    json("tools/tiles/map-build-cache-inventory.annual-2026.5.plan.json"),
    text("docs/prompts/infrarelease-deutschland-jahreslauf.md"),
  ]);
  assert.deepEqual(currentNotices, historicalNotices);
  assert.equal(evidence.inputs.find(({ id }) => id === "map-asset-notices-spec").file, "tools/tiles/map-asset-notices.annual-2026.5.json");
  assert.match(prompt, /<MAP_ASSET_NOTICES_SPEC>[\s\S]*Karten-Capture und[\s\S]*Static-Sources-Builder/u);
  assert.equal(manifest.schema, "zugfolge-gdal-runtime-bundle/v1");
  assert.deepEqual(manifest.platform, { arch: "x64", os: "win32" });
  assert.equal(manifest.entryPoint.sourceFile, "var/tooling-pinned/gdal-3.13.2/ogr2ogr.exe");
  assert.equal(manifest.inventory.files, 514);
  assert.equal(manifest.inventory.bytes, 790021286);
  const expectedMappings = new Map(manifest.files.map(({ sourceFile, cacheFile }) => [cacheFile, sourceFile]));
  expectedMappings.set("tools/gdal-runtime-3.13.2-win32-x64/manifest.json", "tools/tiles/gdal-runtime.3.13.2-win32-x64.manifest.json");
  const actualMappings = new Map(cachePlan.files.filter(({ cacheFile }) => expectedMappings.has(cacheFile)).map(({ sourceFile, cacheFile }) => [cacheFile, sourceFile]));
  assert.equal(actualMappings.size, expectedMappings.size);
  assert.deepEqual(actualMappings, expectedMappings);
  assert.match(prompt, /build-gdal-semantic-pmtiles\.mjs <SEMANTIC_TILE_INPUTS> <SEMANTIC_TILE_INPUT_ROOT> <SEMANTIC_PMTILES_OUTPUT> <GDAL_RUNTIME_MANIFEST> \./u);
});
