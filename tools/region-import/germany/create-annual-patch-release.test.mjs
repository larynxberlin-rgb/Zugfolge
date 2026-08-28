import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAnnualPatchRelease,
  createCurrentOperationalDependencyContractClosure,
} from "./create-annual-patch-release.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../..");
const OPERATIONAL_EXECUTION_IMPORT_CLOSURE = Object.freeze([
  "tools/region-import/germany/annual-create-new-artifact.mjs",
  "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs",
  "tools/region-import/germany/operational-infrastructure-v2-execution-pins.mjs",
  "tools/region-import/germany/operational-infrastructure-v2-outer-execution-receipt.mjs",
  "tools/region-import/germany/operational-infrastructure-v2-publication.mjs",
  "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.windows.ps1",
  "tools/region-import/germany/operational-infrastructure-v2-system-launcher.linux.py",
  "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1",
  "tools/region-import/germany/operational-infrastructure-v2.mjs",
  "tools/region-import/germany/operational-validator-rebuild-evidence.mjs",
  "tools/region-import/germany/operational-windows-anchor-helper.dll",
  "tools/region-import/germany/print-operational-infrastructure-v2-system-launch-command.mjs",
  "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
  "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs",
  "tools/region-import/materialize-operational-infrastructure-v2.mjs",
  "tools/region-import/operational-infrastructure-binding.mjs",
  "tools/tiles/create-new-output.mjs",
]);
const OPERATIONAL_EXECUTION_RUNNER_BUNDLE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs";
const PENDING_REAL_BUILD = "PENDING_REAL_ANNUAL_RELEASE_BUILD";
const CHECKED_IN_VALIDATOR_REBUILD_SPEC = join(
  HERE,
  "operational-validator-rebuild.annual-2026.5.json",
);
const GTFS_SNAPSHOT_BYTES = 14_797_184;
const GTFS_SNAPSHOT_SHA256 = "cbebbcb73e1807df793c26411873b2df442e6ce38d28fd0593a78e5ae93912c5";
const GTFS_SNAPSHOT_HASH = "811fcafe581e73409b373ec5e2568dbb44048d604be834d1aa998abe4a35a8a7";
const TRANSFER_DEMANDS_BYTES = 6_697_294;
const TRANSFER_DEMANDS_SHA256 = "2c8c688a9ce963afbdca75fee526b581bc21be402aabcbaf1abd09ea65418cdf";
const CANONICAL_HARDENING_FILES = Object.freeze([
  "tools/region-import/germany/operational-infrastructure.annual-{patch}.json",
  "tools/region-import/germany/release-artifacts.annual-{patch}.json",
  "tools/region-import/germany/synthetic-operational-b.{patch}.policy.json",
  "tools/region-import/germany/synthetic-operational-closure.annual-{patch}.json",
  "tools/region-import/germany/timetable-route-compiler.annual-{patch}.json",
  "tools/tiles/map-build-cache-inventory.annual-{patch}.plan.json",
  "tools/tiles/map-package.annual-{patch}.plan.json",
  "tools/tiles/map-release-build-evidence.annual-{patch}.spec.json",
  "tools/region-import/germany/release.annual-{patch}.config.json",
  "tools/region-import/germany/operational-validator-rebuild.annual-{patch}.json",
  "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-{patch}.json",
  "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-{patch}.json",
]);
const CANONICAL_HARDENING_TEXT_FILES = Object.freeze([
  "tools/audits/germany-{patch}-alpha-world-runtime.real.test.mjs",
  "tools/audits/germany-{patch}-signed-game-staging.real.test.mjs",
]);

test("eingecheckte 2026.5-Operational-Closure entspricht dem gemeinsamen finalen Repin bytegenau", async () => {
  const files = await createCurrentOperationalDependencyContractClosure({
    repositoryRoot: REPOSITORY_ROOT,
    targetPatch: "2026.5",
  });
  assert.deepEqual(Object.keys(files).sort(), [
    "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json",
    "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
    "tools/region-import/germany/operational-validator-rebuild.annual-2026.5.json",
    "tools/region-import/germany/release.annual-2026.5.config.json",
  ]);
  for (const [file, content] of Object.entries(files)) {
    assert.deepEqual(await readFile(join(REPOSITORY_ROOT, ...file.split("/"))), Buffer.from(content, "utf8"),
      `${file} driftet vom gemeinsamen finalen Operational-v2-Repin.`);
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-annual-patch-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const files = [
    "contracts/release.annual-{patch}.json",
    "contracts/package.annual-{patch}.plan.json",
    "tools/tiles/map-build-cache-inventory.annual-{patch}.plan.json",
    "tools/tiles/map-release-build-evidence.annual-{patch}.spec.json",
  ];
  for (const template of files) {
    const path = join(root, template.replace("{patch}", "2026.4"));
    await mkdir(dirname(path), { recursive: true });
    const value = template.includes("map-build-cache-inventory")
      ? {
        schema: "zugfolge-map-build-cache-inventory-plan/v1",
        releaseId: "infra-deutschland-2026.4",
        files: [
          {
            sourceFile: "var/derived/germany-2026.4/timetable-routes-v2.jsonseq",
            cacheFile: "derived/infra-deutschland-2026.4/timetable-routes-v2.jsonseq",
          },
          {
            sourceFile: "var/derived/germany-2026.4/timetable-routes-v2.derivation-report.json",
            cacheFile: "derived/infra-deutschland-2026.4/timetable-routes-v2.derivation-report.json",
          },
          {
            sourceFile: "var/derived/germany-2026.4/operational-infrastructure-v2.json",
            cacheFile: "derived/infra-deutschland-2026.4/operational-infrastructure-v2.json",
          },
        ],
      }
      : template.includes("map-release-build-evidence")
      ? {
        schema: "zugfolge-map-release-build-evidence-spec/v2",
        releaseId: "infra-deutschland-2026.4",
        inputs: [
          {
            id: "gtfs-region-snapshot",
            kind: "derived-input",
            file: "var/derived/germany-2026.4/gtfs-region.json",
            expectedBytes: 123,
            expectedSha256: "a".repeat(64),
          },
          {
            id: "timetable-routes-v2-report",
            kind: "derived-input",
            version: "infra-deutschland-2026.4",
            file: "var/derived/germany-2026.4/timetable-routes-v2.derivation-report.json",
            cacheFile: "derived/infra-deutschland-2026.4/timetable-routes-v2.derivation-report.json",
          },
        ],
        candidatePackage: {
          retainedTrustedKeyIds: ["zugfolge-alpha-2026", "zugfolge-alpha-2026.3"],
        },
        tools: [],
        outputs: [
          "basemap-pmtiles",
          "semantic-pmtiles",
          "read-model",
          "operational-infrastructure-v2",
          "style",
          "delivery-manifest",
          "quality-report",
        ].map((kind) => ({ id: kind, kind, file: `var/derived/germany-2026.4/${kind}`, installFile: `${kind}.bin` })),
      }
      : { id: "infra-deutschland-2026.4", path: "var/derived/germany-2026.4" };
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  const textFiles = ["audits/germany-{patch}.mjs"];
  const audit = join(root, textFiles[0].replace("{patch}", "2026.4"));
  await mkdir(dirname(audit), { recursive: true });
  await writeFile(audit, 'export const releaseId = "infra-deutschland-2026.4";\nexport const artifactRootEnv = "ZUGFOLGE_REAL_GERMANY_2026_4_ROOT";\n', "utf8");
  return { files, root, textFiles };
}

function buildEvidenceBaseline() {
  return {
    schema: "zugfolge-map-release-build-evidence-spec/v2",
    releaseId: "infra-deutschland-2026.4",
    inputs: [
      {
        id: "gtfs-region-snapshot",
        kind: "derived-input",
        file: "var/derived/germany-2026.4/gtfs-region.json",
        expectedBytes: 123,
        expectedSha256: "a".repeat(64),
      },
      {
        id: "timetable-routes-v2-report",
        kind: "derived-input",
        version: "infra-deutschland-2026.4",
        file: "var/derived/germany-2026.4/timetable-routes-v2.derivation-report.json",
        cacheFile: "derived/infra-deutschland-2026.4/timetable-routes-v2.derivation-report.json",
      },
    ],
    candidatePackage: {
      retainedTrustedKeyIds: ["zugfolge-alpha-2026", "zugfolge-alpha-2026.3"],
    },
    tools: [],
    outputs: [
      "basemap-pmtiles",
      "semantic-pmtiles",
      "read-model",
      "operational-infrastructure-v2",
      "style",
      "delivery-manifest",
      "quality-report",
    ].map((kind) => ({
      id: kind,
      kind,
      file: `var/derived/germany-2026.4/${kind}`,
      installFile: `${kind}.bin`,
    })),
  };
}

function baselineAlphaAudit() {
  return `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAlphaWorld } from "../region-import/build-alpha-world.mjs";

const REPOSITORY_ROOT = ".";
const WORLD_ID = "0db56535-a466-44a8-a991-38a8a1f7566c";
const REGION_ID = "mitteldeutschland-b";
const INFRA_RELEASE_ID = "infra-deutschland-2026.4";
const POSTGRES_DATABASE_NAME = /^zugfolge_germany_e2e_[a-z0-9_]+$/u;
const EXPECTED_ALPHA_DEPLOYMENT_HASH = "${"a".repeat(64)}";
const EXPECTED_ALPHA_UNSIGNED_DEPLOYMENT = Object.freeze({
  bytes: 7_057_730,
  sha256: "${"b".repeat(64)}",
});
const EXPECTED_ALPHA_SIGNED_DEPLOYMENT = Object.freeze({
  bytes: 7_058_016,
  sha256: "${"c".repeat(64)}",
});
const EXPECTED_ALPHA_TYPESCRIPT_BUILD_SET_SHA256 = "${"d".repeat(64)}";
const EXPECTED_INFRA_BINDING = Object.freeze({
  schemaVersion: "zugfolge-operational-infrastructure-binding/v2",
  infraReleaseId: INFRA_RELEASE_ID,
  file: "operational-infrastructure-v2.json",
  bytes: 983_736_272,
  sha256: "${"e".repeat(64)}",
  stateHash: "${"f".repeat(64)}",
});

async function fileProof(path) {
  return { path };
}

async function runtimeBuildProof() {}

test("Runtime-Build-Proof bindet NAPI- und TypeScript-Bytes und prueft Expected-Pins", () => {});

test("Top-level-Akzeptanz bleibt ohne exakten Linux-cgroup-v2-No-Swap-Beleg rot", () => {});

async function realAudit() {
  const artifactRoot = ".";
  const unsignedPath = "alpha-world-deployment.2026.4.json";
  const reuseDeployments = false;
  const reuseUnsignedDeployment = false;
  const runtimeBuild = {};
  const authorityRendering = {};
    const builderResult = reuseDeployments || reuseUnsignedDeployment
      ? undefined
      : await buildAlphaWorld([
        join(artifactRoot, "alpha-world-build-configuration.json"),
        join(artifactRoot, "gtfs-region-20260810-v2.json"),
        join(artifactRoot, "alpha-fleet-v2-migration/compiled/fleet-authority-release-catalog-v1.json"),
        join(artifactRoot, "map-release-free-v2/public/infra-release.json"),
        join(REPOSITORY_ROOT, "tools/region-import/specifications/economy-release-alpha-2026.1.json"),
        unsignedPath,
        join(artifactRoot, "public-world-deploy-configuration.json"),
        join(artifactRoot, "operational-infrastructure-v2.json"),
        join(artifactRoot, "timetable-routes-v2.jsonseq"),
        join(artifactRoot, "alpha-fleet-v2-migration/compiled/vehicle-catalog-compile-receipt-v4.json"),
        join(artifactRoot, "alpha-fleet-v2-migration/compiled/operational-vehicle-inventory-v2.json"),
        join(artifactRoot, "alpha-fleet-v2-migration/vehicle-catalog-source-v2.json"),
        join(artifactRoot, "alpha-fleet-v2-migration/vehicle-world-seed-v3.json"),
        join(artifactRoot, "alpha-fleet-v2-migration/compiled/vehicle-catalog-v3.json"),
      ]);
  return {
      builder: builderResult ?? {
        execution: "fixture",
        worldId: "fixture-world",
        operationalTrainCount: unsigned.deployment.regionalSimulation.trains.length,
      },
      runtimeBuild,
      authorityRendering,
  };
}

void realAudit;
`;
}

function baselineSignedStagingAudit() {
  return `import assert from "node:assert/strict";
function expectedManifestProof(bytes, sha) {
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0, "Erwartete .4-Manifestbytezahl ist ungueltig.");
  assert.match(sha ?? "", /^[a-f0-9]{64}$/u, "Erwarteter .4-Manifest-SHA-256 ist ungueltig.");
}
function trustedDeliveryKeys(parsed) {
  assert.ok(parsed["zugfolge-map-deutschland-2026.4"], "Der Deutschland-2026.4-Delivery-Key fehlt im Trust-Register.");
  assert.equal(Object.hasOwn(parsed, "zugfolge-map-deutschland-2026.3"), false);
}
const expected = {
      operationalStateHash: "${"f".repeat(64)}",
};
void expectedManifestProof;
void trustedDeliveryKeys;
void expected;
`;
}

async function baselineHardeningFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-annual-patch-canonical-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const baselineFiles = new Map([
    ["tools/region-import/germany/operational-infrastructure.annual-2026.4.json", {
      schema: "zugfolge-germany-operational-infrastructure-derivation/v2",
      infraReleaseId: "infra-deutschland-2026.4",
      layers: {
        timetableRoutes: "var/derived/germany-2026.4/timetable-routes-v2.jsonseq",
      },
      policy: {
        id: "synthetic-operational-b/v2",
        minimumOverlapMm: 200_000,
        defaultProtectionSystem: "pzb",
        regionBoundaryId: "region:deutschland-ebo",
        rzueLayoutId: "rzue-deutschland-2026.4-synthetic-b-v2",
      },
    }],
    ["tools/region-import/germany/release-artifacts.annual-2026.4.json", {
      schema: "zugfolge-infra-release-artifact-spec/v2",
      artifacts: [
        { id: "operational-infrastructure-2026.4", kind: "operational-infrastructure-v2" },
        { id: "quality-report-2026.4", kind: "quality-report" },
      ],
    }],
    ["tools/region-import/germany/synthetic-operational-b.2026.4.policy.json", {
      schema: "zugfolge-synthetic-operational-policy/v2",
      id: "synthetic-operational-b/v2",
      requiredInputRoles: ["timetable-route-report", "timetable-routes", "tracks"],
      requiredDimensions: ["route-versions", "complete-pinned-timetable-routes", "free-gtfs-route-provenance"],
      rules: [
        { id: "pinned-timetable-route-coverage/v1", effect: "pinned routes" },
        { id: "free-gtfs-route-provenance/v2", effect: "Bind the v2 derivation report byte-for-byte." },
      ],
      compilerPolicy: {
        id: "synthetic-operational-b/v2",
        minimumOverlapMm: 200_000,
        defaultProtectionSystem: "pzb",
        regionBoundaryId: "region:deutschland-ebo",
        rzueLayoutId: "rzue-deutschland-2026.4-synthetic-b-v2",
      },
    }],
    ["tools/region-import/germany/synthetic-operational-closure.annual-2026.4.json", {
      schema: "zugfolge-synthetic-operational-closure-inputs/v2",
      releaseId: "infra-deutschland-2026.4",
      timetableRouteReportFile: "timetable-routes-v2.derivation-report.json",
      gtfsSnapshotFile: "gtfs-region-20260810-v2.json",
      operationalArtifactFile: "operational-infrastructure-v2.json",
    }],
    ["tools/region-import/germany/timetable-route-compiler.annual-2026.4.json", {
      schema: "zugfolge-germany-timetable-route-compiler/v3",
      infraReleaseId: "infra-deutschland-2026.4",
      gtfsSnapshot: {
        path: "var/derived/germany-2026.4/gtfs-region.json",
        expectedBytes: 123,
        expectedFileSha256: "a".repeat(64),
        expectedSnapshotHash: "b".repeat(64),
      },
      selection: { expectedSnapshotSegmentCount: 2_481, expectedEligibleSegmentCount: 1_679 },
      output: "var/derived/germany-2026.4/timetable-routes-v2.jsonseq",
      report: "var/derived/germany-2026.4/timetable-routes-v2.derivation-report.json",
    }],
    ["tools/tiles/map-build-cache-inventory.annual-2026.4.plan.json", {
      schema: "zugfolge-map-build-cache-inventory-plan/v1",
      releaseId: "infra-deutschland-2026.4",
      files: [
        {
          sourceFile: "var/derived/germany-2026.4/timetable-routes-v2.jsonseq",
          cacheFile: "derived/infra-deutschland-2026.4/timetable-routes-v2.jsonseq",
        },
        {
          sourceFile: "var/derived/germany-2026.4/timetable-routes-v2.derivation-report.json",
          cacheFile: "derived/infra-deutschland-2026.4/timetable-routes-v2.derivation-report.json",
        },
      ],
    }],
    ["tools/tiles/map-package.annual-2026.4.plan.json", {
      schema: "zugfolge-map-package-plan/v2",
      packageId: "zugfolge-map-deutschland",
      version: "2026.4",
      artifacts: [],
      auxiliaryFiles: [
        {
          id: "operational-infrastructure-2026.4",
          kind: "operational-infrastructure-v2",
          artifactInventory: "var/derived/germany-2026.4/release-artifacts.v2.json",
        },
        { id: "style-dark", kind: "style" },
      ],
    }],
    ["tools/tiles/map-release-build-evidence.annual-2026.4.spec.json", buildEvidenceBaseline()],
    ["tools/region-import/germany/release.annual-2026.4.config.json", {
      release: { releaseId: "infra-deutschland-2026.4" },
      pipeline: {
        operationalDeriver: {
          entrypoint: "tools/region-import/germany/run-operational-infrastructure-v2.mjs",
          specification: "tools/region-import/germany/operational-infrastructure.annual-2026.4.json",
          candidate: "var/derived/germany-2026.4/operational-infrastructure-v2.candidate.json",
          report: "var/derived/germany-2026.4/operational-infrastructure-v2.derivation-report.json",
          output: "var/derived/germany-2026.4/operational-infrastructure-v2.json",
        },
      },
    }],
    ["tools/audits/germany-2026.4-alpha-world-runtime.real.test.mjs", baselineAlphaAudit()],
    ["tools/audits/germany-2026.4-signed-game-staging.real.test.mjs", baselineSignedStagingAudit()],
  ]);
  const sourceBytes = new Map();
  for (const [relativePath, value] of baselineFiles) {
    const bytes = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    sourceBytes.set(relativePath, bytes);
  }
  for (const relativePath of OPERATIONAL_EXECUTION_IMPORT_CLOSURE) {
    const target = join(root, ...relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(REPOSITORY_ROOT, ...relativePath.split("/")), target);
  }
  {
    const target = join(root, ...OPERATIONAL_EXECUTION_RUNNER_BUNDLE.split("/"));
    await copyFile(join(REPOSITORY_ROOT, ...OPERATIONAL_EXECUTION_RUNNER_BUNDLE.split("/")), target);
  }
  return { root, sourceBytes };
}

test("migriert die hermetische 58b2f5c-.4-Form target-only und laesst alle Quellen bytegleich", async (t) => {
  const { root, sourceBytes } = await baselineHardeningFixture(t);
  const result = await createAnnualPatchRelease({
    repositoryRoot: root,
    sourcePatch: "2026.4",
    targetPatch: "2026.5",
    files: CANONICAL_HARDENING_FILES,
    textFiles: CANONICAL_HARDENING_TEXT_FILES,
  });

  assert.deepEqual(result.files, [
    "tools/region-import/germany/operational-infrastructure.annual-2026.5.json",
    "tools/region-import/germany/release-artifacts.annual-2026.5.json",
    "tools/region-import/germany/synthetic-operational-b.2026.5.policy.json",
    "tools/region-import/germany/synthetic-operational-closure.annual-2026.5.json",
    "tools/region-import/germany/timetable-route-compiler.annual-2026.5.json",
    "tools/tiles/map-build-cache-inventory.annual-2026.5.plan.json",
    "tools/tiles/map-package.annual-2026.5.plan.json",
    "tools/tiles/map-release-build-evidence.annual-2026.5.spec.json",
    "tools/region-import/germany/release.annual-2026.5.config.json",
    "tools/region-import/germany/operational-validator-rebuild.annual-2026.5.json",
    "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
    "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json",
    "tools/audits/germany-2026.5-alpha-world-runtime.real.test.mjs",
    "tools/audits/germany-2026.5-signed-game-staging.real.test.mjs",
  ]);
  for (const [relativePath, before] of sourceBytes) {
    assert.deepEqual(await readFile(join(root, relativePath)), before, `${relativePath} wurde veraendert.`);
  }
  for (const relativePath of result.files) {
    const target = await readFile(join(root, relativePath), "utf8");
    assert.doesNotMatch(
      target,
      /timetable-transfer-demands-v1|timetable-routes-v2\.transfer-demands-v1\.json|zugfolge-timetable-transfer-demands\/v1/u,
      `${relativePath} enthaelt einen aktuellen V1-Transferfallback.`,
    );
  }

  const operational = JSON.parse(await readFile(join(root, result.files[0]), "utf8"));
  assert.equal(operational.infraReleaseId, "infra-deutschland-2026.5");
  assert.deepEqual(
    {
      expectedBytes: operational.layers.transferDemands.expectedBytes,
      expectedSha256: operational.layers.transferDemands.expectedSha256,
    },
    { expectedBytes: TRANSFER_DEMANDS_BYTES, expectedSha256: TRANSFER_DEMANDS_SHA256 },
  );
  assert.deepEqual(
    {
      minimumBerthEndClearanceMm: operational.policy.minimumBerthEndClearanceMm,
      maximumStablingPathEdges: operational.policy.maximumStablingPathEdges,
      maximumStablingPathLengthMm: operational.policy.maximumStablingPathLengthMm,
      simulatedOperationalBerthFallback: operational.policy.simulatedOperationalBerthFallback,
      maximumDirectDwellMs: operational.policy.maximumDirectDwellMs,
      terminalFormationLengthsMm: operational.policy.terminalFormationLengthsMm,
    },
    {
      minimumBerthEndClearanceMm: 10_000,
      maximumStablingPathEdges: 64,
      maximumStablingPathLengthMm: 10_000_000,
      simulatedOperationalBerthFallback: "real-osm-service-yard-then-spur-then-unclassified-rail/v1",
      maximumDirectDwellMs: 1_200_000,
      terminalFormationLengthsMm: [46_560, 69_860],
    },
  );

  const releaseArtifacts = JSON.parse(await readFile(join(root, result.files[1]), "utf8"));
  assert.deepEqual(releaseArtifacts.artifacts.map(({ kind }) => kind), [
    "operational-infrastructure-v2",
    "movement-route-templates-v2",
    "timetable-transfer-demands-v2",
    "quality-report",
  ]);

  const policy = JSON.parse(await readFile(join(root, result.files[2]), "utf8"));
  assert.deepEqual(policy.requiredInputRoles, [
    "timetable-route-report",
    "timetable-routes",
    "timetable-transfer-demands",
    "tracks",
  ]);
  assert.deepEqual(policy.requiredDimensions, [
    "route-versions",
    "complete-pinned-timetable-routes",
    "daily-physical-circulations",
    "real-transfer-route-coverage",
    "free-gtfs-route-provenance",
  ]);
  assert.equal(policy.rules[1].id, "daily-physical-circulation-and-transfer-coverage/v2");
  assert.match(policy.rules[2].effect, /v4 derivation report/u);
  assert.deepEqual(policy.compilerPolicy.terminalFormationLengthsMm, [46_560, 69_860]);

  const closure = JSON.parse(await readFile(join(root, result.files[3]), "utf8"));
  assert.equal(closure.timetableRouteReportFile, "timetable-routes-v2.derivation-report-v4.json");
  assert.equal(closure.timetableTransferDemandsFile, "timetable-routes-v2.transfer-demands-v2.json");

  const timetable = JSON.parse(await readFile(join(root, result.files[4]), "utf8"));
  assert.equal(timetable.schema, "zugfolge-germany-timetable-route-compiler/v5");
  assert.equal(timetable.dailyCirculation.rule, "lot-local-playable-path-cover-with-explicit-physical-transition-partition/v2");
  assert.deepEqual(
    {
      expectedBytes: timetable.gtfsSnapshot.expectedBytes,
      expectedFileSha256: timetable.gtfsSnapshot.expectedFileSha256,
      expectedSnapshotHash: timetable.gtfsSnapshot.expectedSnapshotHash,
    },
    {
      expectedBytes: GTFS_SNAPSHOT_BYTES,
      expectedFileSha256: GTFS_SNAPSHOT_SHA256,
      expectedSnapshotHash: GTFS_SNAPSHOT_HASH,
    },
  );
  assert.deepEqual(
    [
      timetable.selection.expectedSnapshotSegmentCount,
      timetable.selection.expectedEligibleSegmentCount,
      timetable.dailyCirculation.expectedLotCount,
      timetable.dailyCirculation.expectedJourneyChainCount,
      timetable.dailyCirculation.expectedCirculationCount,
      timetable.dailyCirculation.expectedPlannedTransitionCount,
      timetable.dailyCirculation.expectedTurnaroundDemandCount,
      timetable.dailyCirculation.expectedTransferDemandCount,
      timetable.dailyCirculation.expectedTransferLotCount,
    ],
    [2_481, 1_679, 52, 1_677, 197, 1_677, 1_595, 82, 39],
  );
  assert.equal(timetable.report, "var/derived/germany-2026.5/timetable-routes-v2.derivation-report-v4.json");
  assert.equal(timetable.transferOutput, "var/derived/germany-2026.5/timetable-routes-v2.transfer-demands-v2.json");

  const cachePlan = JSON.parse(await readFile(join(root, result.files[5]), "utf8"));
  const operationalReleaseEvidenceFiles = [
    ["operational-native-receipt", "operational-infrastructure-v2.native-receipt.json"],
    ["operational-publication-receipt", "operational-infrastructure-v2.publication-receipt.json"],
    ["operational-outer-execution-receipt", "operational-infrastructure-v2.outer-execution-receipt.json"],
    ["operational-outer-execution-receipt-completion", "operational-infrastructure-v2.outer-execution-receipt.json.zugfolge-complete.json"],
    ["operational-annual-plan", "toolchain/zugfolge-infra-release-annual-plan.json"],
    ["operational-annual-plan-completion", "toolchain/zugfolge-infra-release-annual-plan.json.zugfolge-complete.json"],
    ["operational-annual-executor-start-evidence", "toolchain/zugfolge-infra-release-annual-executor-start-evidence.json"],
    ["operational-annual-executor-start-evidence-completion", "toolchain/zugfolge-infra-release-annual-executor-start-evidence.json.zugfolge-complete.json"],
    ["operational-validator-rebuild-attestation", "toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json"],
    ["operational-execution-authority-attestation", "toolchain/zugfolge-operational-v2-execution-authority.sigstore.json"],
    ["operational-attestation-verifier", "toolchain/gh-2.94.0-windows-amd64.exe"],
    ["operational-attestation-trusted-root", "toolchain/github-attestation-trusted-root.jsonl"],
  ];
  assert.deepEqual(
    cachePlan.files.filter(({ sourceFile }) => sourceFile.includes("timetable-routes-v2.derivation-report")),
    [{
      sourceFile: "var/derived/germany-2026.5/timetable-routes-v2.derivation-report-v4.json",
      cacheFile: "derived/infra-deutschland-2026.5/timetable-routes-v2.derivation-report-v4.json",
    }],
  );
  for (const fileName of [
    "operational-infrastructure-v2.movement-route-templates-v2.json",
    "timetable-routes-v2.transfer-demands-v2.json",
  ]) {
    assert.equal(cachePlan.files.filter(({ sourceFile }) => sourceFile.endsWith(`/${fileName}`)).length, 1);
  }
  for (const [, fileName] of operationalReleaseEvidenceFiles) {
    assert.deepEqual(
      cachePlan.files.filter(({ sourceFile }) => sourceFile.endsWith(`/${fileName}`)),
      [{
        sourceFile: `var/derived/germany-2026.5/${fileName}`,
        cacheFile: `derived/infra-deutschland-2026.5/${fileName}`,
      }],
    );
  }
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe"
      && cacheFile === "tools/zugfolge-infra-release/infra-deutschland-2026.5/aba354ec1937452a491087626ec0adea36ef6695/c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4/zugfolge-infra-release.exe"
  )));
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json"
      && cacheFile === "derived/infra-deutschland-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json"
  )));
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-source-aba354ec1937452a491087626ec0adea36ef6695-3f267637dcd52dded45ca921d27863149b3fd2919b7bb2e9d881b381c04565af.tar"
      && cacheFile === "derived/infra-deutschland-2026.5/toolchain/zugfolge-infra-release-source-aba354ec1937452a491087626ec0adea36ef6695-3f267637dcd52dded45ca921d27863149b3fd2919b7bb2e9d881b381c04565af.tar"
  )));
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-provenance-aba354ec1937452a491087626ec0adea36ef6695.json"
      && cacheFile === "derived/infra-deutschland-2026.5/toolchain/zugfolge-infra-release-rebuild-provenance-aba354ec1937452a491087626ec0adea36ef6695.json"
  )));
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-aba354ec1937452a491087626ec0adea36ef6695-official.exe"
      && cacheFile === "tools/zugfolge-infra-release/infra-deutschland-2026.5/aba354ec1937452a491087626ec0adea36ef6695/official/zugfolge-infra-release.exe"
  )));

  const mapPackage = JSON.parse(await readFile(join(root, result.files[6]), "utf8"));
  assert.deepEqual(mapPackage.operationalProvenanceSource, {
    publicationReceiptFile: "var/derived/germany-2026.5/operational-infrastructure-v2.publication-receipt.json",
  });
  assert.deepEqual(mapPackage.operationalAuthoritySource, {
    buildEvidenceSpecFile: "tools/tiles/map-release-build-evidence.annual-2026.5.spec.json",
  });
  assert.deepEqual(mapPackage.auxiliaryFiles.map(({ kind }) => kind), [
    "operational-infrastructure-v2",
    "movement-route-templates-v2",
    "timetable-transfer-demands-v2",
    "style",
  ]);

  const evidence = JSON.parse(await readFile(join(root, result.files[7]), "utf8"));
  assert.equal(evidence.schema, "zugfolge-map-release-build-evidence-spec/v3");
  assert.equal(evidence.outputs.length, 9);
  const gtfsEvidence = evidence.inputs.filter(({ id }) => id === "gtfs-region-snapshot");
  assert.equal(gtfsEvidence.length, 1);
  assert.equal(gtfsEvidence[0].expectedBytes, GTFS_SNAPSHOT_BYTES);
  assert.equal(gtfsEvidence[0].expectedSha256, GTFS_SNAPSHOT_SHA256);
  assert.deepEqual(
    evidence.inputs.filter(({ id }) => id === "timetable-routes-v2-report"),
    [{
      id: "timetable-routes-v2-report",
      kind: "derived-input",
      version: "infra-deutschland-2026.5",
      file: "var/derived/germany-2026.5/timetable-routes-v2.derivation-report-v4.json",
      cacheFile: "derived/infra-deutschland-2026.5/timetable-routes-v2.derivation-report-v4.json",
    }],
  );
  assert.deepEqual(
    evidence.inputs.filter(({ id }) => operationalReleaseEvidenceFiles.some(([expectedId]) => expectedId === id)),
    operationalReleaseEvidenceFiles.map(([id, fileName]) => ({
      id,
      kind: "derived-input",
      version: "infra-deutschland-2026.5",
      file: `var/derived/germany-2026.5/${fileName}`,
      cacheFile: `derived/infra-deutschland-2026.5/${fileName}`,
      ...(id === "operational-attestation-verifier" ? {
        expectedBytes: 40_998_712,
        expectedSha256: "91ed1eff1819a96b34bc2ca3adc01822c807ae1bb883c01ad9fdf335bf242b38",
      } : {}),
      ...(id === "operational-attestation-trusted-root" ? {
        expectedBytes: 34_634,
        expectedSha256: "65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c",
      } : {}),
    })),
  );
  assert.deepEqual(evidence.candidatePackage.retainedTrustedKeyIds, [
    "zugfolge-alpha-2026",
    "zugfolge-alpha-2026.3",
    "zugfolge-map-deutschland-2026.4",
  ]);
  assert.equal(evidence.candidatePackage.retainedTrustedKeyIds.includes("zugfolge-map-deutschland-2026.5"), false);
  assert.deepEqual(evidence.outputs.slice(-2).map(({ kind }) => kind), [
    "movement-route-templates-v2",
    "timetable-transfer-demands-v2",
  ]);
  assert.deepEqual(
    evidence.inputs.filter(({ id }) => [
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
    ].includes(id)).map(({ id }) => id),
    [
      "operational-validator-rebuild-evidence",
      "operational-native-receipt-capture",
      "operational-recovery-publisher",
      "operational-recovery-publisher-implementation",
      "operational-v2-deriver",
      "operational-v2-materializer",
      "create-new-output-contract",
      "operational-v2-binding",
      "operational-validator-rebuild-bootstrap",
      "operational-validator-rebuild-spec",
      "operational-validator-rebuild-verifier",
      "operational-validator-rebuild-cli",
    ],
  );
  assert.deepEqual(evidence.tools[0], {
    id: "operational-v2-validator",
    kind: "binary",
    version: "operational-validator-build-commit",
    file: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe",
    cacheFile: "tools/zugfolge-infra-release/infra-deutschland-2026.5/aba354ec1937452a491087626ec0adea36ef6695/c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4/zugfolge-infra-release.exe",
    expectedBytes: 8_382_277,
    expectedSha256: "c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4",
  });
  assert.deepEqual(evidence.tools[1], {
    id: "operational-v2-validator-rebuild",
    kind: "binary",
    version: "operational-validator-rebuild-proof",
    file: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-aba354ec1937452a491087626ec0adea36ef6695-official.exe",
    cacheFile: "tools/zugfolge-infra-release/infra-deutschland-2026.5/aba354ec1937452a491087626ec0adea36ef6695/official/zugfolge-infra-release.exe",
  });

  const releaseConfig = JSON.parse(await readFile(
    join(root, "tools/region-import/germany/release.annual-2026.5.config.json"),
    "utf8",
  ));
  const { directSystemLaunch, ...operationalDeriverWithoutDirectSystemLaunch } = releaseConfig.pipeline.operationalDeriver;
  assert.deepEqual(operationalDeriverWithoutDirectSystemLaunch, {
    primaryRunner: "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs",
    primaryRunnerMode: "system-launcher-held-bundle-stdin-v1",
    systemCommandBuilder: "tools/region-import/germany/print-operational-infrastructure-v2-system-launch-command.mjs",
    systemCommandBuilderMode: "source-only-print-direct-command-v1",
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

  const validatorRebuildBytes = await readFile(join(root, result.files[9]));
  const validatorRebuild = JSON.parse(validatorRebuildBytes.toString("utf8"));
  const executionPinsBytes = await readFile(join(root, result.files[10]));
  const executionPins = JSON.parse(executionPinsBytes.toString("utf8"));
  assert.deepEqual(
    validatorRebuildBytes,
    await readFile(CHECKED_IN_VALIDATOR_REBUILD_SPEC),
    "Generator und eingecheckter Validator-Rebuild-Vertrag muessen byteidentisch sein.",
  );
  assert.deepEqual(Object.keys(validatorRebuild).sort(), [
    "authority",
    "binaries",
    "build",
    "pe",
    "producer",
    "provenance",
    "receipt",
    "releaseId",
    "schema",
    "source",
    "toolchain",
  ]);
  assert.equal(validatorRebuild.releaseId, "infra-deutschland-2026.5");
  assert.equal(validatorRebuild.schema, "zugfolge-operational-validator-rebuild-spec/v3");
  assert.deepEqual(validatorRebuild.authority, {
    annualExecutorPlan: {
      arguments: [
        "plan",
        "tools/region-import/germany/release.annual-2026.5.config.json",
        "tools/region-import/germany/source-catalog.json",
        "tools/guards/quellenregister.json",
      ],
      directContractFile: "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json",
      maxOutputBytes: 4_194_304,
      mode: "held-helper-independent-supervisor-plan-only-v1",
      planFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json",
      startEvidenceFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json",
      startEvidenceSchema: "zugfolge-operational-validator-annual-executor-start-evidence/v1",
      timeoutMilliseconds: 120_000,
    },
    artifactAttestation: "github-sigstore-build-provenance-required-v1",
    attestation: {
      bundleFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json",
      predicateType: "https://slsa.dev/provenance/v1",
      subjects: [
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-aba354ec1937452a491087626ec0adea36ef6695-official.exe",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-provenance-aba354ec1937452a491087626ec0adea36ef6695.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe",
        "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json.zugfolge-complete.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json.zugfolge-complete.json",
      ],
      verification: {
        command: "gh attestation verify",
        denySelfHostedRunners: true,
        signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml",
      },
    },
    environment: "github-hosted-fresh-windows-vm-v1",
    event: "workflow_dispatch",
    repository: "larynxberlin-rgb/Zugfolge",
    requiredRef: "refs/heads/main",
    runnerImages: ["windows-2025", "windows-2022"],
    workflowFile: ".github/workflows/operational-validator-rebuild-evidence.yml",
  });
  assert.equal(validatorRebuild.source.commit, "aba354ec1937452a491087626ec0adea36ef6695");
  assert.deepEqual(validatorRebuild.source.tree, {
    fileCount: 1_325,
    manifestSha256: "3276cda6c04f5e48d89c4e7686900a263e8b2ba0a13ce9393d1d096f1dacf1c5",
    totalBytes: 24_541_942,
  });
  assert.equal(validatorRebuild.source.vendor.archive.sha256, "17611dd9dca437185a59e6696efe21cc64d9e86b03d48fcebe6d5546688cc5f9");
  assert.equal(validatorRebuild.source.vendor.cargoConfig.sha256, "77e9219c27274120197571fd165cbe4121963b5ad3bc0b20b383c86ef0ce6c2b");
  assert.equal(validatorRebuild.source.vendor.remapPrefix, "C:\\Users\\laryn\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f");
  assert.equal(validatorRebuild.toolchain.anchor.mode, "windows-powershell-held-helper-private-dacl-mitigated-v3");
  assert.deepEqual(validatorRebuild.toolchain.anchor.helperAssembly, executionPins.runner.anchorHelper);
  assert.equal(validatorRebuild.toolchain.manifest.sha256, "48778f5992c78401aa46f33e99ce96c6e58c5a6fd93c331f788ec73e24fb0d38");
  assert.equal(validatorRebuild.toolchain.root, "C:\\zugfolge-operational-toolchain\\1.94.1-x86_64-pc-windows-gnu");
  assert.deepEqual(validatorRebuild.build.command.slice(0, 7), [
    "cargo", "--config", "$PINNED_CARGO_CONFIG", "build", "--manifest-path", "$PINNED_CARGO_MANIFEST", "--locked",
  ]);
  assert.deepEqual(validatorRebuild.build.environmentPolicy.allowedInherited, []);
  assert.equal(validatorRebuild.build.environmentPolicy.fixed.CARGO_BUILD_JOBS, "1");
  assert.equal(validatorRebuild.build.processLimits.maxOutputBytes, 16_777_216);
  assert.equal(validatorRebuild.binaries.preserved.sha256, "c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4");
  assert.equal(validatorRebuild.pe.normalizedSha256, "ae39f5a8378641be0d02be56e93bf585a49a6e65bc1f5a02b77cd2bd556d38cb");
  assert.deepEqual(Object.keys(validatorRebuild.producer), ["bundle", "entrypoint", "executionPins", "implementation"]);
  assert.deepEqual(validatorRebuild.producer.bundle, executionPins.runner.bundle);
  assert.deepEqual(validatorRebuild.producer.entrypoint, executionPins.runner.entrypoint);
  assert.deepEqual(validatorRebuild.producer.executionPins, {
    bytes: executionPinsBytes.length,
    file: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
    sha256: createHash("sha256").update(executionPinsBytes).digest("hex"),
  });
  assert.deepEqual(
    validatorRebuild.producer.implementation,
    executionPins.runner.importClosure.find(({ file }) => file === "tools/region-import/germany/operational-validator-rebuild-evidence.mjs"),
  );
  assert.deepEqual(validatorRebuild.receipt, {
    file: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json",
  });

  assert.equal(executionPins.schema, "zugfolge-germany-operational-v2-execution-pins/v1");
  assert.equal(executionPins.releaseId, "infra-deutschland-2026.5");
  assert.deepEqual(executionPins.runner.roots.map(({ file }) => file), [
    "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs",
    "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
    "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs",
  ]);
  assert.deepEqual(executionPins.runner.importClosure.map(({ file }) => file), [
    "tools/region-import/germany/annual-create-new-artifact.mjs",
    "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs",
    "tools/region-import/germany/operational-infrastructure-v2-execution-pins.mjs",
    "tools/region-import/germany/operational-infrastructure-v2-outer-execution-receipt.mjs",
    "tools/region-import/germany/operational-infrastructure-v2-publication.mjs",
    "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1",
    "tools/region-import/germany/operational-infrastructure-v2.mjs",
    "tools/region-import/germany/operational-validator-rebuild-evidence.mjs",
    "tools/region-import/germany/operational-windows-anchor-helper.dll",
    "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
    "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs",
    "tools/region-import/materialize-operational-infrastructure-v2.mjs",
    "tools/region-import/operational-infrastructure-binding.mjs",
    "tools/tiles/create-new-output.mjs",
  ]);
  assert.deepEqual(
    executionPins.runner.anchorHelper,
    executionPins.runner.importClosure.find(({ file }) => file === "tools/region-import/germany/operational-windows-anchor-helper.dll"),
  );
  assert.equal(executionPins.validator.rebuildSpecification, result.files[9]);
  assert.equal(executionPins.validator.rebuildEvidence, "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json");
  const directSystemLaunchBytes = await readFile(join(root, result.files[11]));
  const directSystemLaunchContract = JSON.parse(directSystemLaunchBytes.toString("utf8"));
  assert.deepEqual(directSystemLaunchContract.executionPins, {
    file: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
    bytes: executionPinsBytes.length,
    sha256: createHash("sha256").update(executionPinsBytes).digest("hex"),
    schema: "zugfolge-germany-operational-v2-execution-pins/v1",
  });
  const expectedTrustedExecutor = {
    file: executionPins.validator.file,
    buildCommit: executionPins.validator.buildCommit,
    bytes: executionPins.validator.bytes,
    sha256: executionPins.validator.sha256,
  };
  assert.deepEqual(directSystemLaunchContract.trustedExecutor, expectedTrustedExecutor);
  assert.deepEqual(directSystemLaunch, {
    platform: "win32",
    contract: {
      file: "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json",
      bytes: directSystemLaunchBytes.length,
      sha256: createHash("sha256").update(directSystemLaunchBytes).digest("hex"),
      schema: "zugfolge-operational-v2-direct-system-launch-contract/v1",
      releaseId: "infra-deutschland-2026.5",
      executionPins: directSystemLaunchContract.executionPins,
      trustedExecutor: expectedTrustedExecutor,
    },
  });

  const alphaAudit = await readFile(join(root, result.files[12]), "utf8");
  assert.match(alphaAudit, /validateAlphaWorldBuildConfiguration/u);
  assert.match(alphaAudit, /releaseBoundAlphaWorldBuilderInputs/u);
  assert.match(alphaAudit, /buildAlphaWorld\(builderInputs\.argv\)/u);
  assert.match(alphaAudit, /builderSidecars: builderInputs\.sidecars/u);
  assert.match(alphaAudit, /inputs\.argv\.slice\(9, 11\)/u);
  assert.match(alphaAudit, /timetable-routes-v2\.transfer-demands-v2\.json/u);
  assert.match(alphaAudit, /zugfolge-timetable-transfer-demands\/v2/u);
  assert.match(alphaAudit, /const EXPECTED_ALPHA_DEPLOYMENT_HASH = "PENDING_REAL_ANNUAL_RELEASE_BUILD";/u);
  assert.match(alphaAudit, /const EXPECTED_ALPHA_TYPESCRIPT_BUILD_SET_SHA256 = "PENDING_REAL_ANNUAL_RELEASE_BUILD";/u);
  for (const blockName of ["EXPECTED_ALPHA_UNSIGNED_DEPLOYMENT", "EXPECTED_ALPHA_SIGNED_DEPLOYMENT", "EXPECTED_INFRA_BINDING"]) {
    const block = alphaAudit.match(new RegExp(`const ${blockName} = Object\\.freeze\\(\\{[\\s\\S]*?\\n\\}\\);`, "u"));
    assert.ok(block, `${blockName} fehlt im Zielaudit.`);
    assert.match(block[0], /  bytes: 0,/u);
    assert.match(block[0], /  sha256: "PENDING_REAL_ANNUAL_RELEASE_BUILD",/u);
  }
  assert.match(alphaAudit, /  stateHash: "PENDING_REAL_ANNUAL_RELEASE_BUILD",/u);
  assert.match(alphaAudit, /throw new Error\("PENDING_REAL_ANNUAL_RELEASE_BUILD: Deutschland-Alpha-Real-Audit 2026\.5/u);

  const stagingAudit = await readFile(join(root, result.files[13]), "utf8");
  assert.match(stagingAudit, /operationalStateHash: "PENDING_REAL_ANNUAL_RELEASE_BUILD"/u);
  assert.match(stagingAudit, /Erwartete \.5-Manifestbytezahl ist ungueltig\./u);
  assert.match(stagingAudit, /Erwarteter \.5-Manifest-SHA-256 ist ungueltig\./u);
  assert.doesNotMatch(stagingAudit, /Erwartete \.4-Manifest/u);
  assert.doesNotMatch(stagingAudit, /Erwarteter \.4-Manifest/u);
  assert.match(stagingAudit, /Object\.hasOwn\(parsed, "zugfolge-map-deutschland-2026\.4"\)/u);
  assert.match(stagingAudit, /parsed\["zugfolge-map-deutschland-2026\.5"\]/u);
  assert.match(stagingAudit, /Object\.hasOwn\(parsed, "zugfolge-map-deutschland-2026\.3"\), false/u);
  assert.match(stagingAudit, /throw new Error\("PENDING_REAL_ANNUAL_RELEASE_BUILD: Deutschland-Signed-Game-Staging-Audit 2026\.5/u);
});

test("publiziert Pins, Direct-Contract und Release-Config aus einem byteidentischen Dependency-Snapshot", async (t) => {
  const { root } = await baselineHardeningFixture(t);
  const atomicFiles = [
    "tools/region-import/germany/release.annual-{patch}.config.json",
    "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-{patch}.json",
    "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-{patch}.json",
  ];
  let snapshotCount = 0;
  const result = await createAnnualPatchRelease({
    repositoryRoot: root,
    sourcePatch: "2026.4",
    targetPatch: "2026.5",
    files: atomicFiles,
    textFiles: [],
    hooks: {
      afterOperationalDependencySnapshot: () => {
        snapshotCount += 1;
      },
    },
  });
  assert.equal(snapshotCount, 1);
  assert.deepEqual(result.files, atomicFiles.map((template) => template.replace("{patch}", "2026.5")));

  const releaseConfig = JSON.parse(await readFile(join(root, result.files[0]), "utf8"));
  const executionPinsBytes = await readFile(join(root, result.files[1]));
  const directSystemLaunchBytes = await readFile(join(root, result.files[2]));
  const directSystemLaunch = JSON.parse(directSystemLaunchBytes.toString("utf8"));
  assert.deepEqual(directSystemLaunch.executionPins, {
    file: result.files[1],
    bytes: executionPinsBytes.length,
    sha256: createHash("sha256").update(executionPinsBytes).digest("hex"),
    schema: "zugfolge-germany-operational-v2-execution-pins/v1",
  });
  const executionPins = JSON.parse(executionPinsBytes.toString("utf8"));
  const expectedTrustedExecutor = {
    file: executionPins.validator.file,
    buildCommit: executionPins.validator.buildCommit,
    bytes: executionPins.validator.bytes,
    sha256: executionPins.validator.sha256,
  };
  assert.deepEqual(directSystemLaunch.trustedExecutor, expectedTrustedExecutor);
  assert.deepEqual(releaseConfig.pipeline.operationalDeriver.directSystemLaunch.contract, {
    file: result.files[2],
    bytes: directSystemLaunchBytes.length,
    sha256: createHash("sha256").update(directSystemLaunchBytes).digest("hex"),
    schema: "zugfolge-operational-v2-direct-system-launch-contract/v1",
    releaseId: "infra-deutschland-2026.5",
    executionPins: directSystemLaunch.executionPins,
    trustedExecutor: expectedTrustedExecutor,
  });
});

test("verweigert jede unvollstaendige Pins-Direct-Config-Jahresrelease-Closure vor der Mutation", async (t) => {
  const { root } = await baselineHardeningFixture(t);
  const releaseConfigTemplate = "tools/region-import/germany/release.annual-{patch}.config.json";
  const rebuildTemplate = "tools/region-import/germany/operational-validator-rebuild.annual-{patch}.json";
  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files: [releaseConfigTemplate],
      textFiles: [],
    }),
    /unteilbare Jahresrelease-Closure/u,
  );
  await assert.rejects(
    readFile(join(root, releaseConfigTemplate.replace("{patch}", "2026.5"))),
    /ENOENT/u,
  );
  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files: [rebuildTemplate],
      textFiles: [],
    }),
    /Operational-Validator-Rebuild-v3 muss gemeinsam mit der unteilbaren Operational-v2-Dependency-Closure/u,
  );
  await assert.rejects(
    readFile(join(root, rebuildTemplate.replace("{patch}", "2026.5"))),
    /ENOENT/u,
  );
});

test("verweigert Dependency-Drift zwischen vorbereiteten Release-Config- und Pins-Vertraegen vor jeder Veroeffentlichung", async (t) => {
  const { root } = await baselineHardeningFixture(t);
  const atomicFiles = [
    "tools/region-import/germany/release.annual-{patch}.config.json",
    "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-{patch}.json",
    "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-{patch}.json",
  ];
  const mutatedDependency = join(
    root,
    "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs",
  );
  let publicationCount = 0;
  let mutationCount = 0;

  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files: atomicFiles,
      textFiles: [],
      publishLink: async (...arguments_) => {
        publicationCount += 1;
        return link(...arguments_);
      },
      hooks: {
        afterPreparedContract: async ({ template }) => {
          if (template !== "tools/region-import/germany/release.annual-{patch}.config.json") return;
          mutationCount += 1;
          await writeFile(mutatedDependency, "// absichtlicher Snapshot-Drift\n", "utf8");
        },
      },
    }),
    /Dependency-Byte-Snapshot driftete vor der Veroeffentlichung.*run-capture-operational-infrastructure-v2\.mjs/u,
  );
  assert.equal(mutationCount, 1);
  assert.equal(publicationCount, 0, "Snapshot-Drift darf keinen einzigen Zielvertrag publizieren.");
  for (const template of atomicFiles) {
    await assert.rejects(
      readFile(join(root, template.replace("{patch}", "2026.5"))),
      /ENOENT/u,
      `${template} wurde trotz Snapshot-Drift publiziert.`,
    );
  }
});

test("rollt Dependency-Drift nach allen Publish-Links atomar zurueck", async (t) => {
  const { root } = await baselineHardeningFixture(t);
  const atomicFiles = [
    "tools/region-import/germany/release.annual-{patch}.config.json",
    "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-{patch}.json",
    "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-{patch}.json",
  ];
  const mutatedDependency = join(
    root,
    "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs",
  );
  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files: atomicFiles,
      textFiles: [],
      hooks: {
        afterPublishedTargets: async () => {
          await writeFile(mutatedDependency, "// Snapshot-Drift nach Publish\n", "utf8");
        },
      },
    }),
    /Dependency-Byte-Snapshot driftete vor der Veroeffentlichung.*run-capture-operational-infrastructure-v2\.mjs/u,
  );
  for (const template of atomicFiles) {
    await assert.rejects(
      readFile(join(root, template.replace("{patch}", "2026.5"))),
      /ENOENT/u,
      `${template} blieb nach spaetem Dependency-Drift bestehen.`,
    );
  }
});

test("rollt Dependency-Drift waehrend der Staging-Bereinigung im finalen Crosscheck zurueck", async (t) => {
  const { root } = await baselineHardeningFixture(t);
  const atomicFiles = [
    "tools/region-import/germany/release.annual-{patch}.config.json",
    "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-{patch}.json",
    "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-{patch}.json",
  ];
  const mutatedDependency = join(
    root,
    "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs",
  );
  let mutated = false;
  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files: atomicFiles,
      textFiles: [],
      hooks: {
        beforeOwnedFileQuarantine: async ({ owned }) => {
          if (mutated || !owned.path.endsWith(".stage")) return;
          mutated = true;
          await writeFile(mutatedDependency, "// Snapshot-Drift waehrend Cleanup\n", "utf8");
        },
      },
    }),
    /Dependency-Byte-Snapshot driftete vor der Veroeffentlichung.*run-capture-operational-infrastructure-v2\.mjs/u,
  );
  assert.equal(mutated, true);
  for (const template of atomicFiles) {
    await assert.rejects(
      readFile(join(root, template.replace("{patch}", "2026.5"))),
      /ENOENT/u,
      `${template} blieb nach Dependency-Drift waehrend Cleanup bestehen.`,
    );
  }
});

test("verweigert einen als Alt-Key eingemischten neuen .5-Delivery-Key vor jeder Mutation", async (t) => {
  const { root } = await baselineHardeningFixture(t);
  const evidencePath = join(root, "tools/tiles/map-release-build-evidence.annual-2026.4.spec.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.candidatePackage.retainedTrustedKeyIds.push("zugfolge-map-deutschland-2026.4");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files: CANONICAL_HARDENING_FILES,
      textFiles: CANONICAL_HARDENING_TEXT_FILES,
    }),
    /neue Delivery-Key darf nicht als beizubehaltender Alt-Key/u,
  );
  await assert.rejects(
    readFile(join(root, "tools/region-import/germany/operational-infrastructure.annual-2026.5.json")),
    /ENOENT/u,
  );
});

test("verweigert eine bereits target-only umgeschriebene forensische .4-Quelle vor jeder Mutation", async (t) => {
  const { root } = await baselineHardeningFixture(t);
  const operationalPath = join(root, "tools/region-import/germany/operational-infrastructure.annual-2026.4.json");
  const operational = JSON.parse(await readFile(operationalPath, "utf8"));
  operational.layers.transferDemands = {
    path: "var/derived/germany-2026.4/timetable-routes-v2.transfer-demands-v2.json",
    expectedBytes: TRANSFER_DEMANDS_BYTES,
    expectedSha256: TRANSFER_DEMANDS_SHA256,
  };
  await writeFile(operationalPath, `${JSON.stringify(operational, null, 2)}\n`, "utf8");

  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files: CANONICAL_HARDENING_FILES,
      textFiles: CANONICAL_HARDENING_TEXT_FILES,
    }),
    /Operational-v2-Layers\.transferDemands darf in der unveraenderten Quellversion noch nicht existieren/u,
  );
  await assert.rejects(
    readFile(join(root, "tools/region-import/germany/operational-infrastructure.annual-2026.5.json")),
    /ENOENT/u,
  );
});

test("verweigert einen vorab auf v4 vermischten Timetable-Report im historischen Buildcache", async (t) => {
  const { root } = await baselineHardeningFixture(t);
  const cachePath = join(root, "tools/tiles/map-build-cache-inventory.annual-2026.4.plan.json");
  const cachePlan = JSON.parse(await readFile(cachePath, "utf8"));
  const reportEntry = cachePlan.files.find(({ sourceFile }) => sourceFile.endsWith("timetable-routes-v2.derivation-report.json"));
  reportEntry.sourceFile = "var/derived/germany-2026.4/timetable-routes-v2.derivation-report-v4.json";
  reportEntry.cacheFile = "derived/infra-deutschland-2026.4/timetable-routes-v2.derivation-report-v4.json";
  await writeFile(cachePath, `${JSON.stringify(cachePlan, null, 2)}\n`, "utf8");

  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files: CANONICAL_HARDENING_FILES,
      textFiles: CANONICAL_HARDENING_TEXT_FILES,
    }),
    /Buildcache-Zielvertrag besitzt keine exakt migrierbare historische V3-Reportbindung/u,
  );
  await assert.rejects(
    readFile(join(root, "tools/tiles/map-build-cache-inventory.annual-2026.5.plan.json")),
    /ENOENT/u,
  );
});

test("verweigert einen fehlenden Timetable-Report-Input im historischen Build-Evidence-Vertrag", async (t) => {
  const { root } = await baselineHardeningFixture(t);
  const evidencePath = join(root, "tools/tiles/map-release-build-evidence.annual-2026.4.spec.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.inputs = evidence.inputs.filter(({ id }) => id !== "timetable-routes-v2-report");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files: CANONICAL_HARDENING_FILES,
      textFiles: CANONICAL_HARDENING_TEXT_FILES,
    }),
    /Build-Evidence-Zielvertrag bindet den historischen Timetable-Routenbericht nicht exakt einmal/u,
  );
  await assert.rejects(
    readFile(join(root, "tools/tiles/map-release-build-evidence.annual-2026.5.spec.json")),
    /ENOENT/u,
  );
});

test("erstellt den vollstaendigen direkten Jahrespatch create-new und laesst Quellen bytegleich", async (t) => {
  const { files, root, textFiles } = await fixture(t);
  const sourcePath = join(root, "contracts/release.annual-2026.4.json");
  const cacheSourcePath = join(root, "tools/tiles/map-build-cache-inventory.annual-2026.4.plan.json");
  const before = await readFile(sourcePath);
  const cacheBefore = await readFile(cacheSourcePath);

  const result = await createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2026.5", files, textFiles });

  assert.deepEqual(result.files, [
    "contracts/release.annual-2026.5.json",
    "contracts/package.annual-2026.5.plan.json",
    "tools/tiles/map-build-cache-inventory.annual-2026.5.plan.json",
    "tools/tiles/map-release-build-evidence.annual-2026.5.spec.json",
    "audits/germany-2026.5.mjs",
  ]);
  assert.deepEqual(await readFile(sourcePath), before);
  assert.deepEqual(await readFile(cacheSourcePath), cacheBefore);
  assert.deepEqual(JSON.parse(await readFile(join(root, result.files[0]), "utf8")), {
    id: "infra-deutschland-2026.5",
    path: "var/derived/germany-2026.5",
  });
  const cachePlan = JSON.parse(await readFile(join(root, result.files[2]), "utf8"));
  assert.deepEqual(
    cachePlan.files.filter(({ sourceFile }) => sourceFile.includes("timetable-routes-v2.derivation-report")),
    [{
      sourceFile: "var/derived/germany-2026.5/timetable-routes-v2.derivation-report-v4.json",
      cacheFile: "derived/infra-deutschland-2026.5/timetable-routes-v2.derivation-report-v4.json",
    }],
  );
  for (const fileName of [
    "operational-infrastructure-v2.movement-route-templates-v2.json",
    "timetable-routes-v2.transfer-demands-v2.json",
  ]) {
    assert.equal(cachePlan.files.filter(({ sourceFile }) => sourceFile.split("/").at(-1) === fileName).length, 1);
    assert.equal(cachePlan.files.filter(({ cacheFile }) => cacheFile.split("/").at(-1) === fileName).length, 1);
  }
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe"
      && cacheFile === "tools/zugfolge-infra-release/infra-deutschland-2026.5/aba354ec1937452a491087626ec0adea36ef6695/c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4/zugfolge-infra-release.exe"
  )));
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json"
      && cacheFile === "derived/infra-deutschland-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json"
  )));
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-source-aba354ec1937452a491087626ec0adea36ef6695-3f267637dcd52dded45ca921d27863149b3fd2919b7bb2e9d881b381c04565af.tar"
      && cacheFile === "derived/infra-deutschland-2026.5/toolchain/zugfolge-infra-release-source-aba354ec1937452a491087626ec0adea36ef6695-3f267637dcd52dded45ca921d27863149b3fd2919b7bb2e9d881b381c04565af.tar"
  )));
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-provenance-aba354ec1937452a491087626ec0adea36ef6695.json"
      && cacheFile === "derived/infra-deutschland-2026.5/toolchain/zugfolge-infra-release-rebuild-provenance-aba354ec1937452a491087626ec0adea36ef6695.json"
  )));
  assert.ok(cachePlan.files.some(({ sourceFile, cacheFile }) => (
    sourceFile === "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-aba354ec1937452a491087626ec0adea36ef6695-official.exe"
      && cacheFile === "tools/zugfolge-infra-release/infra-deutschland-2026.5/aba354ec1937452a491087626ec0adea36ef6695/official/zugfolge-infra-release.exe"
  )));
  const buildEvidence = JSON.parse(await readFile(join(root, result.files[3]), "utf8"));
  assert.equal(buildEvidence.schema, "zugfolge-map-release-build-evidence-spec/v3");
  assert.deepEqual(buildEvidence.inputs[0], {
    id: "gtfs-region-snapshot",
    kind: "derived-input",
    file: "var/derived/germany-2026.5/gtfs-region.json",
    expectedBytes: GTFS_SNAPSHOT_BYTES,
    expectedSha256: GTFS_SNAPSHOT_SHA256,
  });
  assert.deepEqual(buildEvidence.inputs[1], {
    id: "timetable-routes-v2-report",
    kind: "derived-input",
    version: "infra-deutschland-2026.5",
    file: "var/derived/germany-2026.5/timetable-routes-v2.derivation-report-v4.json",
    cacheFile: "derived/infra-deutschland-2026.5/timetable-routes-v2.derivation-report-v4.json",
  });
  assert.deepEqual(buildEvidence.candidatePackage.retainedTrustedKeyIds, [
    "zugfolge-alpha-2026",
    "zugfolge-alpha-2026.3",
    "zugfolge-map-deutschland-2026.4",
  ]);
  assert.deepEqual(buildEvidence.tools[0], {
    id: "operational-v2-validator",
    kind: "binary",
    version: "operational-validator-build-commit",
    file: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe",
    cacheFile: "tools/zugfolge-infra-release/infra-deutschland-2026.5/aba354ec1937452a491087626ec0adea36ef6695/c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4/zugfolge-infra-release.exe",
    expectedBytes: 8_382_277,
    expectedSha256: "c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4",
  });
  assert.deepEqual(buildEvidence.tools[1], {
    id: "operational-v2-validator-rebuild",
    kind: "binary",
    version: "operational-validator-rebuild-proof",
    file: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-aba354ec1937452a491087626ec0adea36ef6695-official.exe",
    cacheFile: "tools/zugfolge-infra-release/infra-deutschland-2026.5/aba354ec1937452a491087626ec0adea36ef6695/official/zugfolge-infra-release.exe",
  });
  assert.deepEqual(buildEvidence.outputs.slice(-2), [
    {
      id: "operational-movement-routes",
      kind: "movement-route-templates-v2",
      file: "var/derived/germany-2026.5/operational-infrastructure-v2.movement-route-templates-v2.json",
      installFile: "operational-infrastructure-v2.movement-route-templates-v2.json",
    },
    {
      id: "timetable-transfer-demands",
      kind: "timetable-transfer-demands-v2",
      file: "var/derived/germany-2026.5/timetable-routes-v2.transfer-demands-v2.json",
      installFile: "timetable-routes-v2.transfer-demands-v2.json",
    },
  ]);
  assert.equal(
    await readFile(join(root, result.files[4]), "utf8"),
    'export const releaseId = "infra-deutschland-2026.5";\nexport const artifactRootEnv = "ZUGFOLGE_REAL_GERMANY_2026_5_ROOT";\n',
  );
});

test("verweigert vorhandene Ziele vor jeder Mutation", async (t) => {
  const { files, root, textFiles } = await fixture(t);
  const existing = join(root, "contracts/release.annual-2026.5.json");
  await writeFile(existing, "unveraendert\n", "utf8");

  await assert.rejects(
    createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2026.5", files, textFiles }),
    /existiert bereits.*create-new/u,
  );
  assert.equal(await readFile(existing, "utf8"), "unveraendert\n");
  await assert.rejects(readFile(join(root, "contracts/package.annual-2026.5.plan.json")), /ENOENT/u);
});

test("verweigert Pfadaliase, bevor sie target-only Migrationen umgehen koennen", async (t) => {
  const { root } = await baselineHardeningFixture(t);
  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files: ["./tools/region-import/germany/operational-infrastructure.annual-{patch}.json"],
      textFiles: [],
    }),
    /kanonisch|Alias/u,
  );
  await assert.rejects(
    readFile(join(root, "tools/region-import/germany/operational-infrastructure.annual-2026.5.json")),
    /ENOENT/u,
  );
});

test("entfernt eine partiell geschriebene eigene Stagingdatei und publiziert kein Ziel", async (t) => {
  const { files, root, textFiles } = await fixture(t);
  const sourcePath = join(root, "contracts/release.annual-2026.4.json");
  const sourceBefore = await readFile(sourcePath);
  const partialStageOpen = async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (!path.endsWith("0000.stage")) return handle;
    return {
      close: (...args) => handle.close(...args),
      stat: (...args) => handle.stat(...args),
      sync: (...args) => handle.sync(...args),
      writeFile: async (content, encoding) => {
        await handle.writeFile(content.slice(0, 7), encoding);
        throw new Error("simulierter partieller Staging-Write");
      },
    };
  };

  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files,
      textFiles,
      openCreateNewFile: partialStageOpen,
    }),
    /simulierter partieller Staging-Write/u,
  );
  for (const template of [...files, ...textFiles]) {
    await assert.rejects(readFile(join(root, template.replace("{patch}", "2026.5"))), /ENOENT/u);
  }
  assert.deepEqual(await readFile(sourcePath), sourceBefore);
  const releaseControlFiles = await readdir(join(root, "tools/region-import/germany"));
  assert.equal(releaseControlFiles.some((name) => name.startsWith(".annual-patch-release-2026.5")), false);
});

test("rollt gleichlange In-place-Manipulation im Publish-Link vor Erfolg vollstaendig zurueck", async (t) => {
  const { files, root, textFiles } = await fixture(t);
  let publicationCount = 0;
  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files,
      textFiles,
      publishLink: async (stagingPath, targetPath) => {
        publicationCount += 1;
        if (publicationCount === 1) {
          const manipulated = Buffer.from(await readFile(stagingPath));
          manipulated[0] ^= 0x01;
          await writeFile(stagingPath, manipulated);
        }
        await link(stagingPath, targetPath);
      },
    }),
    /nicht die vorbereiteten Zielbytes/u,
  );
  assert.equal(publicationCount, 1);
  for (const template of [...files, ...textFiles]) {
    await assert.rejects(
      readFile(join(root, template.replace("{patch}", "2026.5"))),
      /ENOENT/u,
      `${template} blieb nach manipulierter Veroeffentlichung bestehen.`,
    );
  }
});

test("uebernimmt bei fehlgeschlagenem Handle-stat keine fremde Pfadidentitaet fuer Cleanup", async (t) => {
  const { files, root, textFiles } = await fixture(t);
  let foreignPath;
  let displacedOwnedPath;
  const statFailureOpen = async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (!path.endsWith("0000.stage")) return handle;
    return {
      close: (...args) => handle.close(...args),
      stat: async () => {
        foreignPath = path;
        displacedOwnedPath = `${path}.owned-displaced`;
        await rename(path, displacedOwnedPath);
        await writeFile(path, "fremde-stat-race-datei\n", { flag: "wx" });
        throw new Error("simulierter Handle-stat-Fehler");
      },
      sync: (...args) => handle.sync(...args),
      writeFile: (...args) => handle.writeFile(...args),
    };
  };

  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files,
      textFiles,
      openCreateNewFile: statFailureOpen,
    }),
    /simulierter Handle-stat-Fehler/u,
  );
  assert.equal(await readFile(foreignPath, "utf8"), "fremde-stat-race-datei\n");
  assert.ok((await lstat(displacedOwnedPath)).isFile());
});

test("loescht beim Rollback nur die selbst publizierte Dateidentitaet", async (t) => {
  const { files, root, textFiles } = await fixture(t);
  let firstTarget;
  let publications = 0;
  const replaceBeforeFailure = async (source, target) => {
    publications += 1;
    if (publications === 1) {
      await link(source, target);
      firstTarget = target;
      return;
    }
    await unlink(firstTarget);
    await writeFile(firstTarget, "fremde-datei-darf-nicht-geloescht-werden\n", { flag: "wx" });
    throw new Error("simulierter Publish-Fehler nach Identitaetswechsel");
  };

  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files,
      textFiles,
      publishLink: replaceBeforeFailure,
    }),
    /simulierter Publish-Fehler nach Identitaetswechsel/u,
  );
  assert.equal(await readFile(firstTarget, "utf8"), "fremde-datei-darf-nicht-geloescht-werden\n");
  await assert.rejects(readFile(join(root, "contracts/package.annual-2026.5.plan.json")), /ENOENT/u);
});

test("erhaelt eine fremde Datei beim Austausch exakt zwischen Identitaetspruefung und Quarantaene", async (t) => {
  const { files, root, textFiles } = await fixture(t);
  let firstTarget;
  let publications = 0;
  let raced = false;
  const failSecondPublication = async (source, target) => {
    publications += 1;
    if (publications === 1) {
      await link(source, target);
      firstTarget = target;
      return;
    }
    throw new Error("simulierter zweiter Publish-Fehler");
  };

  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files,
      textFiles,
      publishLink: failSecondPublication,
      hooks: {
        beforeOwnedFileQuarantine: async ({ owned }) => {
          if (raced || owned.path !== firstTarget) return;
          raced = true;
          await rename(firstTarget, `${firstTarget}.owned-displaced`);
          await writeFile(firstTarget, "fremde-race-datei\n", { flag: "wx" });
        },
      },
    }),
    /simulierter zweiter Publish-Fehler/u,
  );
  assert.equal(raced, true);
  assert.equal(await readFile(firstTarget, "utf8"), "fremde-race-datei\n");
});

test("erhaelt eine fremde Datei beim Austausch unmittelbar vor dem finalen Unlink", async (t) => {
  const { files, root, textFiles } = await fixture(t);
  let firstTarget;
  let publications = 0;
  let preservedOwnedPath;
  let raced = false;
  const failSecondPublication = async (source, target) => {
    publications += 1;
    if (publications === 1) {
      await link(source, target);
      firstTarget = target;
      return;
    }
    throw new Error("simulierter zweiter Publish-Fehler vor Final-Unlink");
  };

  await assert.rejects(
    createAnnualPatchRelease({
      repositoryRoot: root,
      sourcePatch: "2026.4",
      targetPatch: "2026.5",
      files,
      textFiles,
      publishLink: failSecondPublication,
      hooks: {
        beforeOwnedFileFinalUnlink: async ({ owned, quarantined }) => {
          if (raced || owned.path !== firstTarget) return;
          raced = true;
          preservedOwnedPath = `${quarantined}.owned-displaced`;
          await rename(quarantined, preservedOwnedPath);
          await writeFile(quarantined, "fremde-final-unlink-datei\n", { flag: "wx" });
        },
      },
    }),
    /simulierter zweiter Publish-Fehler vor Final-Unlink/u,
  );
  assert.equal(raced, true);
  assert.equal(await readFile(firstTarget, "utf8"), "fremde-final-unlink-datei\n");
  assert.ok((await lstat(preservedOwnedPath)).isFile());
});

test("verweigert vorab eingemischte Operational-Sidecars vor jeder Mutation", async (t) => {
  const { files, root, textFiles } = await fixture(t);
  const cacheSourcePath = join(root, "tools/tiles/map-build-cache-inventory.annual-2026.4.plan.json");
  const cacheSource = JSON.parse(await readFile(cacheSourcePath, "utf8"));
  cacheSource.files.push({
    sourceFile: "var/derived/germany-2026.4/operational-infrastructure-v2.movement-route-templates-v2.json",
    cacheFile: "derived/infra-deutschland-2026.4/legacy/operational-infrastructure-v2.movement-route-templates-v2.json",
  });
  await writeFile(cacheSourcePath, `${JSON.stringify(cacheSource, null, 2)}\n`, "utf8");

  await assert.rejects(
    createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2026.5", files, textFiles }),
    /enthaelt bereits das Sidecar Operational-Movement-Route-Templates/u,
  );
  await assert.rejects(readFile(join(root, "contracts/release.annual-2026.5.json")), /ENOENT/u);
});

test("verweigert uebersprungene, fremde oder bereits vermischte Patchidentitaeten", async (t) => {
  const { files, root, textFiles } = await fixture(t);
  await assert.rejects(
    createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2026.6", files, textFiles }),
    /direkte naechste Patch/u,
  );
  await assert.rejects(
    createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2027.5", files, textFiles }),
    /direkte naechste Patch/u,
  );

  const mixed = join(root, "contracts/package.annual-2026.4.plan.json");
  await writeFile(mixed, '{"id":"infra-deutschland-2026.4","future":"2026.5"}\n', "utf8");
  await assert.rejects(
    createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2026.5", files, textFiles }),
    /enthaelt bereits Zielpatch/u,
  );

  await writeFile(mixed, '{"id":"infra-deutschland-2026.4","future":"2026_5"}\n', "utf8");
  await assert.rejects(
    createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2026.5", files, textFiles }),
    /enthaelt bereits Zielpatch/u,
  );
});
