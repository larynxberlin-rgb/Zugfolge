import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { validateMapBuildCacheInventoryPlan } from "../../tiles/map-build-cache-inventory.mjs";
import {
  GERMANY_OPERATIONAL_COMMAND_BUILDER_MODE,
  GERMANY_OPERATIONAL_EXECUTION_COMMAND_BUILDER,
  GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
  GERMANY_OPERATIONAL_EXECUTION_RUNNER_BUNDLE,
  GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE,
  GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
  GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE,
  GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE,
  germanyOperationalSystemLauncherSourceProof,
  serializeGermanyOperationalExecutionPins,
  validateGermanyOperationalExecutionPins,
} from "./operational-infrastructure-v2-execution-pins.mjs";
import { validateOperationalValidatorRebuildSpec } from "./operational-validator-rebuild-evidence.mjs";
import {
  GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_BINDINGS,
  GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA,
  GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_SOURCE_FILE,
  serializeGermanyOperationalDirectSystemLaunchContract,
  validateGermanyOperationalDirectSystemLaunchContract,
} from "./build-operational-infrastructure-v2-direct-system-launch-contract.mjs";

export const ANNUAL_PATCH_CONTRACT_FILES = Object.freeze([
  "tools/region-import/germany/final-quality-inputs.annual-{patch}.json",
  "tools/region-import/germany/operational-infrastructure.annual-{patch}.json",
  "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-{patch}.json",
  "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-{patch}.json",
  "tools/region-import/germany/operational-validator-rebuild.annual-{patch}.json",
  "tools/region-import/germany/operational-quality.annual-{patch}.json",
  "tools/region-import/germany/release-artifacts.annual-{patch}.json",
  "tools/region-import/germany/release.annual-{patch}.config.json",
  "tools/region-import/germany/source-capture.annual-{patch}.plan.json",
  "tools/region-import/germany/synthetic-operational-b.{patch}.policy.json",
  "tools/region-import/germany/synthetic-operational-closure.annual-{patch}.json",
  "tools/region-import/germany/timetable-route-compiler.annual-{patch}.json",
  "tools/tiles/livemap-read-model.annual-{patch}.json",
  "tools/tiles/map-build-cache-inventory.annual-{patch}.plan.json",
  "tools/tiles/map-package.annual-{patch}.plan.json",
  "tools/tiles/map-release-build-evidence.annual-{patch}.spec.json",
  "tools/tiles/map-release.annual-{patch}.spec.json",
  "tools/tiles/static-map-quality.annual-{patch}.json",
  "tools/tiles/static-map-release.annual-{patch}.json",
  "tools/tiles/static-map-sources.annual-{patch}.json",
]);

export const ANNUAL_PATCH_TEXT_FILES = Object.freeze([
  "tools/audits/germany-{patch}-alpha-world-runtime.real.test.mjs",
  "tools/audits/germany-{patch}-signed-game-staging.real.test.mjs",
]);

const PATCH = /^(?<year>[0-9]{4})\.(?<patch>[1-9][0-9]*)$/u;
const BUILD_CACHE_INVENTORY_TEMPLATE = "tools/tiles/map-build-cache-inventory.annual-{patch}.plan.json";
const BUILD_EVIDENCE_TEMPLATE = "tools/tiles/map-release-build-evidence.annual-{patch}.spec.json";
const OPERATIONAL_INFRASTRUCTURE_TEMPLATE = "tools/region-import/germany/operational-infrastructure.annual-{patch}.json";
const OPERATIONAL_EXECUTION_PINS_TEMPLATE = "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-{patch}.json";
const OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_TEMPLATE = "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-{patch}.json";
const OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT = "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs";
const OPERATIONAL_EXECUTION_RUNNER_BUNDLE = GERMANY_OPERATIONAL_EXECUTION_RUNNER_BUNDLE;
const OPERATIONAL_EXECUTION_RUNNER_ROOTS = Object.freeze([
  "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs",
  "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
  OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT,
]);
const OPERATIONAL_EXECUTION_IMPORT_CLOSURE = Object.freeze([
  "tools/region-import/germany/annual-create-new-artifact.mjs",
  "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs",
  "tools/region-import/germany/operational-infrastructure-v2-execution-pins.mjs",
  "tools/region-import/germany/operational-infrastructure-v2-outer-execution-receipt.mjs",
  "tools/region-import/germany/operational-infrastructure-v2-publication.mjs",
  "tools/region-import/germany/operational-infrastructure-v2.mjs",
  "tools/region-import/germany/operational-validator-rebuild-evidence.mjs",
  GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
  "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
  OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT,
  "tools/region-import/materialize-operational-infrastructure-v2.mjs",
  "tools/region-import/operational-infrastructure-binding.mjs",
  "tools/tiles/create-new-output.mjs",
]);
const OPERATIONAL_VALIDATOR_REBUILD_TEMPLATE = "tools/region-import/germany/operational-validator-rebuild.annual-{patch}.json";
const RELEASE_CONFIG_TEMPLATE = "tools/region-import/germany/release.annual-{patch}.config.json";
const OPERATIONAL_DEPENDENCY_TARGET_TEMPLATES = Object.freeze([
  OPERATIONAL_EXECUTION_PINS_TEMPLATE,
  OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_TEMPLATE,
  RELEASE_CONFIG_TEMPLATE,
]);
const RELEASE_ARTIFACTS_TEMPLATE = "tools/region-import/germany/release-artifacts.annual-{patch}.json";
const SYNTHETIC_OPERATIONAL_POLICY_TEMPLATE = "tools/region-import/germany/synthetic-operational-b.{patch}.policy.json";
const SYNTHETIC_OPERATIONAL_CLOSURE_TEMPLATE = "tools/region-import/germany/synthetic-operational-closure.annual-{patch}.json";
const TIMETABLE_ROUTE_COMPILER_TEMPLATE = "tools/region-import/germany/timetable-route-compiler.annual-{patch}.json";
const MAP_PACKAGE_TEMPLATE = "tools/tiles/map-package.annual-{patch}.plan.json";
const ALPHA_WORLD_RUNTIME_AUDIT_TEMPLATE = "tools/audits/germany-{patch}-alpha-world-runtime.real.test.mjs";
const SIGNED_GAME_STAGING_AUDIT_TEMPLATE = "tools/audits/germany-{patch}-signed-game-staging.real.test.mjs";
const PENDING_REAL_BUILD = "PENDING_REAL_ANNUAL_RELEASE_BUILD";
const SHA256 = /^[a-f0-9]{64}$/u;
const HISTORICAL_TIMETABLE_ROUTE_REPORT_FILE = "timetable-routes-v2.derivation-report.json";
const TARGET_TIMETABLE_ROUTE_REPORT_FILE = "timetable-routes-v2.derivation-report-v4.json";
const TIMETABLE_ROUTE_REPORT_INPUT_ID = "timetable-routes-v2-report";
const BUILD_EVIDENCE_V2_OUTPUT_KINDS = Object.freeze([
  "basemap-pmtiles",
  "semantic-pmtiles",
  "read-model",
  "operational-infrastructure-v2",
  "style",
  "delivery-manifest",
  "quality-report",
]);
const REQUIRED_OPERATIONAL_CACHE_SIDECARS = Object.freeze([
  Object.freeze({
    fileName: "operational-infrastructure-v2.movement-route-templates-v2.json",
    name: "Operational-Movement-Route-Templates",
    sourceFile: (patch) => `var/derived/germany-${patch}/operational-infrastructure-v2.movement-route-templates-v2.json`,
    cacheFile: (patch) => `derived/infra-deutschland-${patch}/operational-infrastructure-v2.movement-route-templates-v2.json`,
  }),
  Object.freeze({
    fileName: "timetable-routes-v2.transfer-demands-v2.json",
    name: "Timetable-Transfer-Demands",
    sourceFile: (patch) => `var/derived/germany-${patch}/timetable-routes-v2.transfer-demands-v2.json`,
    cacheFile: (patch) => `derived/infra-deutschland-${patch}/timetable-routes-v2.transfer-demands-v2.json`,
  }),
]);
const REQUIRED_OPERATIONAL_RECOVERY_RECEIPTS = Object.freeze([
  "operational-infrastructure-v2.native-receipt.json",
  "operational-infrastructure-v2.publication-receipt.json",
]);
const REQUIRED_OPERATIONAL_AUTHORITY_INPUTS = Object.freeze([
  Object.freeze({
    id: "operational-outer-execution-receipt",
    fileName: "operational-infrastructure-v2.outer-execution-receipt.json",
  }),
  Object.freeze({
    id: "operational-outer-execution-receipt-completion",
    fileName: "operational-infrastructure-v2.outer-execution-receipt.json.zugfolge-complete.json",
  }),
  Object.freeze({
    id: "operational-annual-plan",
    fileName: "toolchain/zugfolge-infra-release-annual-plan.json",
  }),
  Object.freeze({
    id: "operational-annual-plan-completion",
    fileName: "toolchain/zugfolge-infra-release-annual-plan.json.zugfolge-complete.json",
  }),
  Object.freeze({
    id: "operational-annual-executor-start-evidence",
    fileName: "toolchain/zugfolge-infra-release-annual-executor-start-evidence.json",
  }),
  Object.freeze({
    id: "operational-annual-executor-start-evidence-completion",
    fileName: "toolchain/zugfolge-infra-release-annual-executor-start-evidence.json.zugfolge-complete.json",
  }),
  Object.freeze({
    id: "operational-validator-rebuild-attestation",
    fileName: "toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json",
  }),
  Object.freeze({
    id: "operational-execution-authority-attestation",
    fileName: "toolchain/zugfolge-operational-v2-execution-authority.sigstore.json",
  }),
  Object.freeze({
    id: "operational-attestation-verifier",
    fileName: "toolchain/gh-2.94.0-windows-amd64.exe",
    expectedBytes: 40_998_712,
    expectedSha256: "91ed1eff1819a96b34bc2ca3adc01822c807ae1bb883c01ad9fdf335bf242b38",
  }),
  Object.freeze({
    id: "operational-attestation-trusted-root",
    fileName: "toolchain/github-attestation-trusted-root.jsonl",
    expectedBytes: 34_634,
    expectedSha256: "65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c",
  }),
]);
const OPERATIONAL_VALIDATOR_BUILD_COMMIT_VERSION = "operational-validator-build-commit";
const operationalValidatorSourceFile = (patch, buildCommit, sha256) => `var/derived/germany-${patch}/toolchain/zugfolge-infra-release-${buildCommit}-${sha256}.exe`;
const operationalValidatorCacheFile = (patch, buildCommit, sha256) => `tools/zugfolge-infra-release/infra-deutschland-${patch}/${buildCommit}/${sha256}/zugfolge-infra-release.exe`;
const operationalValidatorRebuildSourceFile = (patch, buildCommit) => `var/derived/germany-${patch}/toolchain/zugfolge-infra-release-rebuild-${buildCommit}-official.exe`;
const operationalValidatorRebuildCacheFile = (patch, buildCommit) => `tools/zugfolge-infra-release/infra-deutschland-${patch}/${buildCommit}/official/zugfolge-infra-release.exe`;
const operationalValidatorRebuildSpecFile = (patch) => `tools/region-import/germany/operational-validator-rebuild.annual-${patch}.json`;
const operationalValidatorRebuildEvidenceFile = (patch) => `var/derived/germany-${patch}/toolchain/zugfolge-infra-release-rebuild-evidence.json`;
const operationalValidatorRebuildEvidenceCacheFile = (patch) => `derived/infra-deutschland-${patch}/toolchain/zugfolge-infra-release-rebuild-evidence.json`;
const operationalValidatorSourceArchiveFile = (patch, buildCommit, sha256) => `var/derived/germany-${patch}/toolchain/zugfolge-infra-release-source-${buildCommit}-${sha256}.tar`;
const operationalValidatorSourceArchiveCacheFile = (patch, buildCommit, sha256) => `derived/infra-deutschland-${patch}/toolchain/zugfolge-infra-release-source-${buildCommit}-${sha256}.tar`;
const operationalValidatorRebuildProvenanceFile = (patch, buildCommit) => `var/derived/germany-${patch}/toolchain/zugfolge-infra-release-rebuild-provenance-${buildCommit}.json`;
const operationalValidatorRebuildProvenanceCacheFile = (patch, buildCommit) => `derived/infra-deutschland-${patch}/toolchain/zugfolge-infra-release-rebuild-provenance-${buildCommit}.json`;
const TARGET_ONLY_MIGRATION_TEMPLATES = Object.freeze([
  BUILD_CACHE_INVENTORY_TEMPLATE,
  BUILD_EVIDENCE_TEMPLATE,
  OPERATIONAL_INFRASTRUCTURE_TEMPLATE,
  OPERATIONAL_EXECUTION_PINS_TEMPLATE,
  OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_TEMPLATE,
  OPERATIONAL_VALIDATOR_REBUILD_TEMPLATE,
  RELEASE_CONFIG_TEMPLATE,
  RELEASE_ARTIFACTS_TEMPLATE,
  SYNTHETIC_OPERATIONAL_POLICY_TEMPLATE,
  SYNTHETIC_OPERATIONAL_CLOSURE_TEMPLATE,
  TIMETABLE_ROUTE_COMPILER_TEMPLATE,
  MAP_PACKAGE_TEMPLATE,
  ALPHA_WORLD_RUNTIME_AUDIT_TEMPLATE,
  SIGNED_GAME_STAGING_AUDIT_TEMPLATE,
]);
const GENERATED_TARGET_ONLY_TEMPLATES = new Set([
  OPERATIONAL_EXECUTION_PINS_TEMPLATE,
  OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_TEMPLATE,
  OPERATIONAL_VALIDATOR_REBUILD_TEMPLATE,
]);
const TURNAROUND_POLICY_V2 = Object.freeze({
  minimumBerthEndClearanceMm: 10_000,
  maximumStablingPathEdges: 64,
  maximumStablingPathLengthMm: 10_000_000,
  simulatedOperationalBerthFallback: "real-osm-service-yard-then-spur-then-unclassified-rail/v1",
  maximumDirectDwellMs: 1_200_000,
  terminalFormationLengthsMm: Object.freeze([46_560, 69_860]),
});
const TIMETABLE_UPSTREAM_V2_2026_5 = Object.freeze({
  patch: "2026.5",
  operationalValidatorBuildCommit: "aba354ec1937452a491087626ec0adea36ef6695",
  operationalValidatorBytes: 8_382_277,
  operationalValidatorSha256: "c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4",
  operationalValidatorRebuildExpectedBytes: 8_382_277,
  operationalValidatorNormalizedPeSha256: "ae39f5a8378641be0d02be56e93bf585a49a6e65bc1f5a02b77cd2bd556d38cb",
  operationalValidatorAuthority: Object.freeze({
    annualExecutorPlan: Object.freeze({
      arguments: Object.freeze([
        "plan",
        "tools/region-import/germany/release.annual-2026.5.config.json",
        "tools/region-import/germany/source-catalog.json",
        "tools/guards/quellenregister.json",
      ]),
      directContractFile: "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json",
      maxOutputBytes: 4_194_304,
      mode: "held-helper-independent-supervisor-plan-only-v1",
      planFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json",
      startEvidenceFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json",
      startEvidenceSchema: "zugfolge-operational-validator-annual-executor-start-evidence/v1",
      timeoutMilliseconds: 120_000,
    }),
    artifactAttestation: "github-sigstore-build-provenance-required-v1",
    attestation: Object.freeze({
      bundleFile: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json",
      predicateType: "https://slsa.dev/provenance/v1",
      subjects: Object.freeze([
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-aba354ec1937452a491087626ec0adea36ef6695-official.exe",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-provenance-aba354ec1937452a491087626ec0adea36ef6695.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe",
        "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json.zugfolge-complete.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json",
        "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json.zugfolge-complete.json",
      ]),
      verification: Object.freeze({
        command: "gh attestation verify",
        denySelfHostedRunners: true,
        signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml",
      }),
    }),
    environment: "github-hosted-fresh-windows-vm-v1",
    event: "workflow_dispatch",
    repository: "larynxberlin-rgb/Zugfolge",
    requiredRef: "refs/heads/main",
    runnerImages: Object.freeze(["windows-2025", "windows-2022"]),
    workflowFile: ".github/workflows/operational-validator-rebuild-evidence.yml",
  }),
  operationalRunnerRuntime: Object.freeze({
    id: "nodejs-24-operational-runner-v1",
    platform: "win32",
    bytes: 92_825_416,
    sha256: "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237",
  }),
  operationalValidatorSourceArchive: Object.freeze({
    bytes: 25_661_440,
    sha256: "3f267637dcd52dded45ca921d27863149b3fd2919b7bb2e9d881b381c04565af",
  }),
  operationalValidatorSourceTree: Object.freeze({
    fileCount: 1_325,
    manifestSha256: "3276cda6c04f5e48d89c4e7686900a263e8b2ba0a13ce9393d1d096f1dacf1c5",
    totalBytes: 24_541_942,
  }),
  operationalValidatorVendor: Object.freeze({
    archive: Object.freeze({
      bytes: 21_238_784,
      sha256: "17611dd9dca437185a59e6696efe21cc64d9e86b03d48fcebe6d5546688cc5f9",
    }),
    cargoConfig: Object.freeze({
      bytes: 101,
      sha256: "77e9219c27274120197571fd165cbe4121963b5ad3bc0b20b383c86ef0ce6c2b",
    }),
    remapPrefix: "C:\\Users\\laryn\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f",
    tree: Object.freeze({
      fileCount: 1_795,
      manifestSha256: "6a7575f2756941f8b9df5a63af652aed1fcb47f3372f7e59a8fdc071ae9ec100",
      totalBytes: 19_587_298,
    }),
  }),
  cargoLock: Object.freeze({
    bytes: 13_125,
    sha256: "929fe3fb52098a0e5d234d5b96f5058b7ba7bf4308d1836e8e0b80307af09403",
  }),
  operationalValidatorToolchain: Object.freeze({
    anchor: Object.freeze({
      mode: "windows-powershell-held-helper-private-dacl-mitigated-v3",
    }),
    cargo: Object.freeze({
      commitHash: "29ea6fb6a5db279426f4cc4e17aa385f05a0cfbc",
      host: "x86_64-pc-windows-gnu",
      release: "1.94.1",
    }),
    cargoPath: "bin/cargo.exe",
    manifest: Object.freeze({
      bytes: 41_312,
      file: "var/derived/germany-2026.5/toolchain/rust-1.94.1-x86_64-pc-windows-gnu-complete-tree-v1.json",
      sha256: "48778f5992c78401aa46f33e99ce96c6e58c5a6fd93c331f788ec73e24fb0d38",
    }),
    platform: "win32",
    root: "C:\\zugfolge-operational-toolchain\\1.94.1-x86_64-pc-windows-gnu",
    rustc: Object.freeze({
      commitHash: "e408947bfd200af42db322daf0fadfe7e26d3bd1",
      host: "x86_64-pc-windows-gnu",
      llvmVersion: "21.1.8",
      release: "1.94.1",
    }),
    rustcPath: "bin/rustc.exe",
  }),
  compilerSchema: "zugfolge-germany-timetable-route-compiler/v5",
  reportSchema: "zugfolge-germany-timetable-route-report/v4",
  dailyPlanSchema: "zugfolge-daily-circulation-plan/v2",
  transferDemandsSchema: "zugfolge-timetable-transfer-demands/v2",
  snapshot: Object.freeze({
    bytes: 14_797_184,
    fileSha256: "cbebbcb73e1807df793c26411873b2df442e6ce38d28fd0593a78e5ae93912c5",
    snapshotHash: "811fcafe581e73409b373ec5e2568dbb44048d604be834d1aa998abe4a35a8a7",
    segmentCount: 2_481,
    eligibleSegmentCount: 1_679,
  }),
  dailyCirculation: Object.freeze({
    expectedLotCount: 52,
    expectedJourneyChainCount: 1_677,
    expectedCirculationCount: 197,
    expectedPlannedTransitionCount: 1_677,
    expectedTurnaroundDemandCount: 1_595,
    expectedTransferDemandCount: 82,
    expectedTransferLotCount: 39,
  }),
  transferDemands: Object.freeze({
    bytes: 6_697_294,
    sha256: "2c8c688a9ce963afbdca75fee526b581bc21be402aabcbaf1abd09ea65418cdf",
  }),
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function timetableUpstreamTarget(targetPatch) {
  invariant(
    targetPatch === TIMETABLE_UPSTREAM_V2_2026_5.patch,
    `Fuer ${targetPatch} fehlt ein real gemessener Timetable-Upstream-v2-Zielvertrag.`,
  );
  return TIMETABLE_UPSTREAM_V2_2026_5;
}

function operationalDependencySnapshotProof(snapshot, file, label) {
  invariant(snapshot !== undefined, `${label} fehlt der gemeinsame Operational-v2-Dependency-Byte-Snapshot.`);
  const proof = snapshot.dependencyProofs.find((candidate) => candidate.file === file);
  invariant(proof !== undefined, `${label} fehlt im gemeinsamen Operational-v2-Dependency-Byte-Snapshot: ${file}`);
  return structuredClone(proof);
}

function createOperationalValidatorRebuildSpecification(targetPatch, operationalDependencySnapshot) {
  const target = timetableUpstreamTarget(targetPatch);
  const buildCommit = target.operationalValidatorBuildCommit;
  const archive = target.operationalValidatorSourceArchive;
  const executionPinsBytes = Buffer.from(operationalDependencySnapshot?.executionPinsContent ?? "", "utf8");
  invariant(executionPinsBytes.length > 0,
    "Operational-Validator-Rebuild-v3 fehlt der gemeinsame Execution-Pins-Byte-Snapshot.");
  const toolchain = structuredClone(target.operationalValidatorToolchain);
  toolchain.anchor = {
    helperAssembly: operationalDependencySnapshotProof(
      operationalDependencySnapshot,
      GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
      "Operational-Validator-Rebuild-v3 Anchor-Helper",
    ),
    mode: toolchain.anchor.mode,
  };
  const specification = {
    authority: structuredClone(target.operationalValidatorAuthority),
    binaries: {
      preserved: {
        bytes: target.operationalValidatorBytes,
        file: operationalValidatorSourceFile(targetPatch, buildCommit, target.operationalValidatorSha256),
        sha256: target.operationalValidatorSha256,
      },
      rebuilt: {
        expectedBytes: target.operationalValidatorRebuildExpectedBytes,
        file: operationalValidatorRebuildSourceFile(targetPatch, buildCommit),
      },
    },
    build: {
      command: [
        "cargo",
        "--config",
        "$PINNED_CARGO_CONFIG",
        "build",
        "--manifest-path",
        "$PINNED_CARGO_MANIFEST",
        "--locked",
        "--offline",
        "--release",
        "-p",
        "zugfolge-infra",
        "--bin",
        "zugfolge-infra-release",
      ],
      environmentPolicy: {
        allowedInherited: [],
        cleared: [
          "AR",
          "CARGO_BUILD_RUSTC",
          "CARGO_BUILD_RUSTC_WRAPPER",
          "CARGO_BUILD_TARGET",
          "CARGO_ENCODED_RUSTFLAGS",
          "CARGO_PROFILE_RELEASE_CODEGEN_UNITS",
          "CARGO_PROFILE_RELEASE_DEBUG",
          "CARGO_PROFILE_RELEASE_LTO",
          "CARGO_PROFILE_RELEASE_OPT_LEVEL",
          "CARGO_PROFILE_RELEASE_PANIC",
          "CARGO_TARGET_DIR",
          "CC",
          "CFLAGS",
          "CXX",
          "CXXFLAGS",
          "LDFLAGS",
          "RUSTC",
          "RUSTC_BOOTSTRAP",
          "RUSTC_WRAPPER",
          "RUSTC_WORKSPACE_WRAPPER",
          "RUSTDOCFLAGS",
          "RUSTFLAGS",
          "RUSTUP_TOOLCHAIN",
          "SOURCE_DATE_EPOCH",
        ],
        fixed: {
          CARGO_BUILD_JOBS: "1",
          CARGO_ENCODED_RUSTFLAGS: "--remap-path-prefix=$HELD_VENDOR_ROOT=$ANNUAL_VENDOR_REMAP_PREFIX",
          CARGO_INCREMENTAL: "0",
          CARGO_NET_OFFLINE: "true",
          CARGO_TERM_COLOR: "never",
        },
        targetDirectory: "external-empty-create-new",
      },
      processLimits: {
        maxOutputBytes: 16_777_216,
        timeoutMilliseconds: 900_000,
      },
      profile: "release",
      targetOutputFile: "release/zugfolge-infra-release.exe",
    },
    pe: {
      allowedNormalizationFields: [
        { bytes: 4, name: "coff-time-date-stamp", offset: 136 },
        { bytes: 4, name: "optional-header-checksum", offset: 216 },
      ],
      format: "PE32+",
      machine: 34_404,
      maxBinaryBytes: 8_388_608,
      normalizedSha256: target.operationalValidatorNormalizedPeSha256,
      sections: [
        { name: ".text", rawData: "non-empty" },
        { name: ".data", rawData: "non-empty" },
        { name: ".rdata", rawData: "non-empty" },
        { name: ".pdata", rawData: "non-empty" },
        { name: ".xdata", rawData: "non-empty" },
        { name: ".bss", rawData: "empty" },
        { name: ".idata", rawData: "non-empty" },
        { name: ".CRT", rawData: "non-empty" },
        { name: ".tls", rawData: "non-empty" },
        { name: ".reloc", rawData: "non-empty" },
      ],
    },
    producer: {
      bundle: operationalDependencySnapshotProof(
        operationalDependencySnapshot,
        OPERATIONAL_EXECUTION_RUNNER_BUNDLE,
        "Operational-Validator-Rebuild-v3 Producer-Bundle",
      ),
      entrypoint: operationalDependencySnapshotProof(
        operationalDependencySnapshot,
        OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT,
        "Operational-Validator-Rebuild-v3 Producer-Entrypoint",
      ),
      executionPins: {
        bytes: executionPinsBytes.length,
        file: contractPath(OPERATIONAL_EXECUTION_PINS_TEMPLATE, targetPatch),
        sha256: createHash("sha256").update(executionPinsBytes).digest("hex"),
      },
      implementation: operationalDependencySnapshotProof(
        operationalDependencySnapshot,
        "tools/region-import/germany/operational-validator-rebuild-evidence.mjs",
        "Operational-Validator-Rebuild-v3 Producer-Implementation",
      ),
    },
    provenance: {
      file: `var/derived/germany-${targetPatch}/toolchain/zugfolge-infra-release-rebuild-provenance-${buildCommit}.json`,
    },
    receipt: {
      file: `var/derived/germany-${targetPatch}/toolchain/zugfolge-infra-release-rebuild-evidence.json`,
    },
    releaseId: `infra-deutschland-${targetPatch}`,
    schema: "zugfolge-operational-validator-rebuild-spec/v3",
    source: {
      archive: {
        bytes: archive.bytes,
        file: `var/derived/germany-${targetPatch}/toolchain/zugfolge-infra-release-source-${buildCommit}-${archive.sha256}.tar`,
        format: "tar",
        sha256: archive.sha256,
      },
      cargoLock: {
        bytes: target.cargoLock.bytes,
        file: "Cargo.lock",
        sha256: target.cargoLock.sha256,
      },
      commit: buildCommit,
      tree: structuredClone(target.operationalValidatorSourceTree),
      vendor: {
        archive: {
          bytes: target.operationalValidatorVendor.archive.bytes,
          file: `var/derived/germany-${targetPatch}/toolchain/zugfolge-infra-cargo-vendor-${buildCommit}-v1.tar`,
          format: "tar",
          sha256: target.operationalValidatorVendor.archive.sha256,
        },
        cargoConfig: {
          bytes: target.operationalValidatorVendor.cargoConfig.bytes,
          file: ".cargo/config.toml",
          sha256: target.operationalValidatorVendor.cargoConfig.sha256,
        },
        remapPrefix: target.operationalValidatorVendor.remapPrefix,
        tree: structuredClone(target.operationalValidatorVendor.tree),
      },
    },
    toolchain,
  };
  validateOperationalValidatorRebuildSpec(specification);
  return `${JSON.stringify(canonicalJsonValue(specification), null, 2)}\n`;
}

async function operationalExecutionFileSnapshot(repositoryRoot, file) {
  const path = pathInside(repositoryRoot, file, `Operational-v2-Execution-Pin ${file}`);
  const [actualRoot, actualPath] = await Promise.all([realpath(repositoryRoot), realpath(path)]);
  invariant(pathIdentity(actualPath) === pathIdentity(resolve(actualRoot, file)), `Operational-v2-Execution-Pin ${file} verwendet einen symbolischen, Junction- oder sonstigen Dateisystemalias.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && before.size > 0n && before.size <= BigInt(Number.MAX_SAFE_INTEGER), `Operational-v2-Execution-Pin ${file} ist keine nichtleere regulaere Datei.`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    invariant(pathAfter.isFile() && !pathAfter.isSymbolicLink()
      && before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && after.dev === pathAfter.dev && after.ino === pathAfter.ino && after.size === pathAfter.size
      && BigInt(bytes.length) === after.size,
    `Operational-v2-Execution-Pin ${file} driftete waehrend der Hashbildung.`);
    return Object.freeze({
      bytes,
      proof: Object.freeze({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }),
    });
  } finally {
    await handle.close();
  }
}

async function operationalExecutionFileProof(repositoryRoot, file) {
  return (await operationalExecutionFileSnapshot(repositoryRoot, file)).proof;
}

function operationalExecutionPinsFromDependencySnapshot(targetPatch, dependencyByFile) {
  const target = timetableUpstreamTarget(targetPatch);
  const launcherSourceFile = target.operationalRunnerRuntime.platform === "win32"
    ? GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE
    : GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE;
  const importClosureFiles = [...OPERATIONAL_EXECUTION_IMPORT_CLOSURE, launcherSourceFile]
    .sort((left, right) => left.localeCompare(right, "en"));
  const proof = (file) => {
    const snapshot = dependencyByFile.get(file);
    invariant(snapshot !== undefined, `Operational-v2-Dependency-Byte-Snapshot fehlt fuer ${file}.`);
    return structuredClone(snapshot.proof);
  };
  const importClosure = importClosureFiles.map(proof);
  const bundle = proof(OPERATIONAL_EXECUTION_RUNNER_BUNDLE);
  const proofByFile = new Map(importClosure.map((proof) => [proof.file, proof]));
  const launcherSourceProof = proof(launcherSourceFile);
  const embeddedLauncherProof = germanyOperationalSystemLauncherSourceProof(target.operationalRunnerRuntime.platform);
  invariant(
    embeddedLauncherProof.sourceBytes === launcherSourceProof.bytes
      && embeddedLauncherProof.sourceSha256 === launcherSourceProof.sha256,
    `Operational-v2-Systemlauncher ${launcherSourceFile} driftet von der eingebetteten kanonischen Quelle.`,
  );
  const value = {
    schema: "zugfolge-germany-operational-v2-execution-pins/v1",
    releaseId: `infra-deutschland-${targetPatch}`,
    runner: {
      anchorHelper: target.operationalRunnerRuntime.platform === "win32"
        ? proof(GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE)
        : null,
      bundle,
      entrypoint: proofByFile.get(OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT),
      roots: OPERATIONAL_EXECUTION_RUNNER_ROOTS.map((file) => proofByFile.get(file)),
      importClosure,
      invocation: {
        mode: "system-launcher-held-bundle-stdin-v1",
        nodeArguments: ["--input-type=module", "-"],
        nodeOptions: null,
      },
      launcher: {
        mode: embeddedLauncherProof.mode,
        sourceBytes: launcherSourceProof.bytes,
        sourceSha256: launcherSourceProof.sha256,
      },
      runtime: structuredClone(target.operationalRunnerRuntime),
    },
    validator: {
      file: operationalValidatorSourceFile(targetPatch, target.operationalValidatorBuildCommit, target.operationalValidatorSha256),
      buildCommit: target.operationalValidatorBuildCommit,
      bytes: target.operationalValidatorBytes,
      sha256: target.operationalValidatorSha256,
      rebuildSpecification: operationalValidatorRebuildSpecFile(targetPatch),
      rebuildEvidence: operationalValidatorRebuildEvidenceFile(targetPatch),
    },
    command: {
      name: "derive-germany-operational-v2",
      argumentPrefix: [],
      argumentFiles: [],
      arguments: [
        "derive-germany-operational-v2",
        "{specification}",
        "{sourceRoot}",
        "{candidate}",
        "{report}",
      ],
      stdoutMaxBytes: 262_144,
    },
  };
  validateGermanyOperationalExecutionPins(value, value.releaseId);
  return serializeGermanyOperationalExecutionPins(value, value.releaseId);
}

function operationalDirectSystemLaunchFromDependencySnapshot(targetPatch, dependencyByFile, executionPinsBytes) {
  const executionPinsFile = contractPath(OPERATIONAL_EXECUTION_PINS_TEMPLATE, targetPatch);
  const executionPins = validateGermanyOperationalExecutionPins(
    JSON.parse(executionPinsBytes.toString("utf8")),
    `infra-deutschland-${targetPatch}`,
  );
  invariant(executionPins.runner.runtime.platform === "win32",
    "Operational-v2-Direct-System-Launch benoetigt Windows-Execution-Pins.");
  const launcherSnapshot = dependencyByFile.get(GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE);
  const bootstrapSnapshot = dependencyByFile.get(GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_SOURCE_FILE);
  invariant(launcherSnapshot !== undefined && bootstrapSnapshot !== undefined,
    "Operational-v2-Dependency-Byte-Snapshot ist fuer den Direct-System-Launch unvollstaendig.");
  invariant(executionPins.runner.launcher.mode === GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE
    && executionPins.runner.launcher.sourceBytes === launcherSnapshot.proof.bytes
    && executionPins.runner.launcher.sourceSha256 === launcherSnapshot.proof.sha256,
  "Operational-v2-Direct-System-Launch-Systemlauncher driftet vom gemeinsamen Dependency-Byte-Snapshot.");
  const value = {
    schema: GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA,
    releaseId: executionPins.releaseId,
    platform: "win32",
    executionPins: {
      file: executionPinsFile,
      bytes: executionPinsBytes.length,
      sha256: createHash("sha256").update(executionPinsBytes).digest("hex"),
      schema: GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
    },
    trustedExecutor: {
      file: executionPins.validator.file,
      buildCommit: executionPins.validator.buildCommit,
      bytes: executionPins.validator.bytes,
      sha256: executionPins.validator.sha256,
    },
    launcher: {
      file: launcherSnapshot.proof.file,
      mode: executionPins.runner.launcher.mode,
      sourceBytes: launcherSnapshot.proof.bytes,
      sourceSha256: launcherSnapshot.proof.sha256,
    },
    dynamicBindings: structuredClone(GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_BINDINGS),
    bootstrap: {
      mode: "held-contract-inline-powershell-v1",
      sourceEncoding: "utf-8",
      sourceBase64: bootstrapSnapshot.bytes.toString("base64"),
      sourceBytes: bootstrapSnapshot.proof.bytes,
      sourceSha256: bootstrapSnapshot.proof.sha256,
    },
  };
  validateGermanyOperationalDirectSystemLaunchContract(value);
  return serializeGermanyOperationalDirectSystemLaunchContract(value);
}

function operationalDirectSystemLaunchProof(targetPatch, content) {
  const contract = JSON.parse(content.toString("utf8"));
  return {
    file: contractPath(OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_TEMPLATE, targetPatch),
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    schema: "zugfolge-operational-v2-direct-system-launch-contract/v1",
    releaseId: contract.releaseId,
    executionPins: structuredClone(contract.executionPins),
    trustedExecutor: structuredClone(contract.trustedExecutor),
  };
}

async function createOperationalDependencyByteSnapshot(targetPatch, repositoryRoot) {
  invariant(/^24\.[0-9]+\.[0-9]+(?:-|$)/u.test(process.versions.node),
    "Operational-v2-Execution-Pins duerfen nur mit der vertraglich festgelegten Node-24-Hauptversion erzeugt werden.");
  const target = timetableUpstreamTarget(targetPatch);
  const launcherSourceFile = target.operationalRunnerRuntime.platform === "win32"
    ? GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE
    : GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE;
  const dependencyFiles = [...new Set([
    ...OPERATIONAL_EXECUTION_IMPORT_CLOSURE,
    launcherSourceFile,
    OPERATIONAL_EXECUTION_RUNNER_BUNDLE,
    GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_SOURCE_FILE,
  ])].sort((left, right) => left.localeCompare(right, "en"));
  const dependencies = await Promise.all(
    dependencyFiles.map(async (file) => [file, await operationalExecutionFileSnapshot(repositoryRoot, file)]),
  );
  const dependencyByFile = new Map(dependencies);
  const executionPinsBytes = operationalExecutionPinsFromDependencySnapshot(targetPatch, dependencyByFile);
  const directSystemLaunchBytes = operationalDirectSystemLaunchFromDependencySnapshot(
    targetPatch,
    dependencyByFile,
    executionPinsBytes,
  );
  return Object.freeze({
    dependencyProofs: Object.freeze(dependencies.map(([, snapshot]) => snapshot.proof)),
    directSystemLaunchContent: directSystemLaunchBytes.toString("utf8"),
    directSystemLaunchProof: Object.freeze(operationalDirectSystemLaunchProof(targetPatch, directSystemLaunchBytes)),
    executionPinsContent: executionPinsBytes.toString("utf8"),
  });
}

export async function createOperationalExecutionPins(targetPatch, repositoryRoot) {
  return (await createOperationalDependencyByteSnapshot(targetPatch, repositoryRoot)).executionPinsContent;
}

export async function createCurrentOperationalDependencyContractClosure({ repositoryRoot, targetPatch }) {
  const root = resolve(repositoryRoot);
  const target = parsedPatch(targetPatch, "Zielpatch");
  invariant(target.patch > 1, "Operational-v2-Current-Closure benoetigt einen direkten historischen Quellpatch.");
  const sourcePatch = `${target.year}.${target.patch - 1}`;
  const snapshot = await createOperationalDependencyByteSnapshot(target.value, root);
  const sourceConfigPath = pathInside(
    root,
    contractPath(RELEASE_CONFIG_TEMPLATE, sourcePatch),
    "Historische Deutschland-Release-Konfiguration",
  );
  const migratedConfig = await readContract(sourceConfigPath, sourcePatch, target.value, "json");
  const contentsByTemplate = new Map([
    [OPERATIONAL_EXECUTION_PINS_TEMPLATE, snapshot.executionPinsContent],
    [OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_TEMPLATE, snapshot.directSystemLaunchContent],
    [OPERATIONAL_VALIDATOR_REBUILD_TEMPLATE, createOperationalValidatorRebuildSpecification(target.value, snapshot)],
    [RELEASE_CONFIG_TEMPLATE, migrateReleaseConfig(migratedConfig, target.value, snapshot)],
  ]);
  const files = Object.freeze({
    ...Object.fromEntries([...contentsByTemplate].map(([template, content]) => [
      contractPath(template, target.value),
      content,
    ])),
  });
  operationalPreparedTargetCrossCheck(
    new Map([...contentsByTemplate].map(([template, content]) => [
      template,
      Buffer.from(content, "utf8"),
    ])),
    snapshot,
    target.value,
  );
  return files;
}

function parsedPatch(value, label) {
  const match = PATCH.exec(value);
  invariant(match !== null, `${label} muss YYYY.PATCH entsprechen.`);
  return Object.freeze({
    patch: Number.parseInt(match.groups.patch, 10),
    value,
    year: Number.parseInt(match.groups.year, 10),
  });
}

function contractPath(template, patch) {
  invariant(typeof template === "string" && template.length > 0, "Jahresvertragspfad fehlt.");
  invariant(template.split("{patch}").length - 1 === 1, "Jahresvertragspfad muss genau einen Patch-Platzhalter besitzen.");
  invariant(template === template.replaceAll("\\", "/"), "Jahresvertragspfad muss kanonische portable Trenner verwenden.");
  const segments = template.split("/");
  invariant(
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "Jahresvertragspfad muss kanonisch sein und darf keine Alias-Segmente enthalten.",
  );
  return template.replaceAll("{patch}", patch);
}

function pathIdentity(path) {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function assertNoMigrationTemplateAlias(root, template, targetPatch) {
  const requestedTarget = pathIdentity(pathInside(root, contractPath(template, targetPatch), "Jahresvertragsziel"));
  for (const canonical of TARGET_ONLY_MIGRATION_TEMPLATES) {
    const canonicalTarget = pathIdentity(pathInside(root, contractPath(canonical, targetPatch), "Kanonisches Jahresvertragsziel"));
    invariant(
      requestedTarget !== canonicalTarget || template === canonical,
      `Jahresvertragspfad ist ein Alias des migrationspflichtigen kanonischen Templates ${canonical}.`,
    );
  }
}

async function assertCanonicalSourceResolution(root, contract, sourcePatch) {
  const [actualRoot, actualSource] = await Promise.all([
    realpath(root),
    realpath(contract.source),
  ]);
  const expectedSource = resolve(actualRoot, contractPath(contract.template, sourcePatch));
  invariant(
    pathIdentity(actualSource) === pathIdentity(expectedSource),
    `Jahresvertragsquelle verwendet einen symbolischen, Junction- oder sonstigen Dateisystemalias: ${contract.template}`,
  );
}

function pathInside(root, path, label) {
  const absolute = resolve(root, path);
  const relation = relative(root, absolute);
  invariant(relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !relation.includes(`${sep}..${sep}`), `${label} verlaesst die Repositorywurzel.`);
  return absolute;
}

async function absent(path, label) {
  try {
    await access(path, constants.F_OK);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} existiert bereits; create-new verweigert die Ueberschreibung.`);
}

function patchTokens(patch) {
  return Object.freeze([patch, patch.replace(".", "_")]);
}

async function readContract(path, sourcePatch, targetPatch, format) {
  const info = await stat(path);
  invariant(info.isFile(), `Jahresvertragsquelle ist keine regulaere Datei: ${path}`);
  const source = await readFile(path, "utf8");
  const sourceTokens = patchTokens(sourcePatch);
  const targetTokens = patchTokens(targetPatch);
  invariant(sourceTokens.some((token) => source.includes(token)), `Jahresvertragsquelle bindet ${sourcePatch} nicht: ${path}`);
  invariant(targetTokens.every((token) => !source.includes(token)), `Jahresvertragsquelle enthaelt bereits Zielpatch ${targetPatch}: ${path}`);
  let target = source;
  for (const [index, token] of sourceTokens.entries()) target = target.replaceAll(token, targetTokens[index]);
  if (format === "json") JSON.parse(target);
  invariant(sourceTokens.every((token) => !target.includes(token)), `Zielvertrag enthaelt weiterhin Quellpatch ${sourcePatch}: ${path}`);
  return target;
}

function jsonObject(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt oder ist kein Objekt.`);
  return value;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} ist kein positiver ganzzahliger Build-Pin.`);
}

function sha256Pin(value, label) {
  invariant(typeof value === "string" && SHA256.test(value), `${label} ist kein SHA-256-Build-Pin.`);
}

function timetableRouteReportCacheBinding(patch, fileName) {
  return Object.freeze({
    sourceFile: `var/derived/germany-${patch}/${fileName}`,
    cacheFile: `derived/infra-deutschland-${patch}/${fileName}`,
  });
}

function timetableRouteReportEvidenceBinding(patch, fileName) {
  return Object.freeze({
    id: TIMETABLE_ROUTE_REPORT_INPUT_ID,
    kind: "derived-input",
    version: `infra-deutschland-${patch}`,
    file: `var/derived/germany-${patch}/${fileName}`,
    cacheFile: `derived/infra-deutschland-${patch}/${fileName}`,
  });
}

function isTimetableRouteReportPath(value) {
  if (typeof value !== "string") return false;
  const fileName = value.split("/").at(-1);
  return fileName === HISTORICAL_TIMETABLE_ROUTE_REPORT_FILE || fileName === TARGET_TIMETABLE_ROUTE_REPORT_FILE;
}

function replaceExactlyOnce(content, pattern, replacement, label) {
  invariant(!pattern.global, `${label}: internes Suchmuster darf nicht global sein.`);
  const matches = [...content.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  invariant(matches.length === 1, `${label} wurde nicht exakt einmal gefunden.`);
  return content.replace(pattern, replacement);
}

function replaceTextExactlyOnce(content, search, replacement, label) {
  invariant(typeof search === "string" && search.length > 0, `${label}: interner Suchtext fehlt.`);
  invariant(content.split(search).length - 1 === 1, `${label} wurde nicht exakt einmal gefunden.`);
  return content.replace(search, replacement);
}

function replaceObjectFreeze(content, name, transform) {
  const pattern = new RegExp(`const ${name} = Object\\.freeze\\(\\{[\\s\\S]*?\\r?\\n\\}\\);`, "u");
  const matches = [...content.matchAll(new RegExp(pattern.source, "gu"))];
  invariant(matches.length === 1, `${name} wurde nicht exakt einmal als Object.freeze-Pinblock gefunden.`);
  return content.replace(pattern, transform(matches[0][0]));
}

function withPendingAuditGuard(content, auditName, targetPatch) {
  invariant(
    !content.includes(`throw new Error("${PENDING_REAL_BUILD}`),
    `${auditName} besitzt bereits einen ausstehenden Real-Build-Guard.`,
  );
  return `${content.trimEnd()}\n\nthrow new Error("${PENDING_REAL_BUILD}: ${auditName} ${targetPatch} muss nach dem realen Jahresrelease-Build neu gepinnt werden.");\n`;
}

function requireAbsentProperties(value, properties, label) {
  for (const property of properties) {
    invariant(!Object.hasOwn(value, property), `${label}.${property} darf in der unveraenderten Quellversion noch nicht existieren.`);
  }
}

function insertObjectFieldsBefore(value, beforeProperty, inserted, label) {
  const entries = Object.entries(value);
  const index = entries.findIndex(([property]) => property === beforeProperty);
  invariant(index >= 0, `${label}.${beforeProperty} fehlt als kanonischer Einfuegeanker.`);
  return Object.fromEntries([
    ...entries.slice(0, index),
    ...Object.entries(inserted),
    ...entries.slice(index),
  ]);
}

function insertArrayValuesAfter(value, afterEntry, inserted, label) {
  invariant(Array.isArray(value), `${label} ist kein Array.`);
  const index = value.findIndex((entry) => entry === afterEntry);
  invariant(index >= 0, `${label} besitzt den kanonischen Einfuegeanker ${afterEntry} nicht.`);
  return [
    ...value.slice(0, index + 1),
    ...inserted,
    ...value.slice(index + 1),
  ];
}

function migrateOperationalInfrastructure(content, targetPatch) {
  const target = timetableUpstreamTarget(targetPatch);
  const value = JSON.parse(content);
  invariant(value.schema === "zugfolge-germany-operational-infrastructure-derivation/v2", "Operational-v2-Zielvertrag besitzt nicht das erwartete Schema.");
  invariant(value.infraReleaseId === `infra-deutschland-${targetPatch}`, "Operational-v2-Zielvertrag besitzt nicht die erwartete Release-ID.");
  const layers = jsonObject(value.layers, "Operational-v2-Layers");
  invariant(
    layers.timetableRoutes === `var/derived/germany-${targetPatch}/timetable-routes-v2.jsonseq`,
    "Operational-v2-Zielvertrag bindet nicht die erwarteten Timetable-Routes.",
  );
  requireAbsentProperties(layers, ["transferDemands"], "Operational-v2-Layers");
  layers.transferDemands = {
    path: `var/derived/germany-${targetPatch}/timetable-routes-v2.transfer-demands-v2.json`,
    expectedBytes: target.transferDemands.bytes,
    expectedSha256: target.transferDemands.sha256,
  };

  const policy = jsonObject(value.policy, "Operational-v2-Policy");
  invariant(
    policy.minimumOverlapMm === 200_000,
    "Operational-v2-Quellpolicy verletzt den historischen Overlap-Grundwert.",
  );
  requireAbsentProperties(policy, Object.keys(TURNAROUND_POLICY_V2), "Operational-v2-Policy");
  value.policy = insertObjectFieldsBefore(
    policy,
    "defaultProtectionSystem",
    {
      ...TURNAROUND_POLICY_V2,
      terminalFormationLengthsMm: [...TURNAROUND_POLICY_V2.terminalFormationLengthsMm],
    },
    "Operational-v2-Policy",
  );
  return `${JSON.stringify(value, null, 2)}\n`;
}

function migrateTimetableRouteCompiler(content, targetPatch) {
  const target = timetableUpstreamTarget(targetPatch);
  const value = JSON.parse(content);
  invariant(value.schema === "zugfolge-germany-timetable-route-compiler/v3", "Timetable-Quellvertrag besitzt nicht das unveraenderte historische v3-Schema.");
  invariant(value.infraReleaseId === `infra-deutschland-${targetPatch}`, "Timetable-Zielvertrag besitzt nicht die erwartete Release-ID.");
  const snapshot = jsonObject(value.gtfsSnapshot, "Timetable-GTFS-Snapshot");
  positiveInteger(snapshot.expectedBytes, "Timetable-GTFS-Snapshot expectedBytes");
  sha256Pin(snapshot.expectedFileSha256, "Timetable-GTFS-Snapshot expectedFileSha256");
  sha256Pin(snapshot.expectedSnapshotHash, "Timetable-GTFS-Snapshot expectedSnapshotHash");
  snapshot.expectedBytes = target.snapshot.bytes;
  snapshot.expectedFileSha256 = target.snapshot.fileSha256;
  snapshot.expectedSnapshotHash = target.snapshot.snapshotHash;

  const selection = jsonObject(value.selection, "Timetable-Auswahl");
  positiveInteger(selection.expectedSnapshotSegmentCount, "Timetable-Ergebnis expectedSnapshotSegmentCount");
  positiveInteger(selection.expectedEligibleSegmentCount, "Timetable-Ergebnis expectedEligibleSegmentCount");
  selection.expectedSnapshotSegmentCount = target.snapshot.segmentCount;
  selection.expectedEligibleSegmentCount = target.snapshot.eligibleSegmentCount;
  requireAbsentProperties(value, ["dailyCirculation", "transferOutput"], "Historischer Timetable-v3-Vertrag");

  const { output, report, ...prefix } = value;
  invariant(output === `var/derived/germany-${targetPatch}/timetable-routes-v2.jsonseq`, "Timetable-Ausgabepfad ist nicht kanonisch.");
  invariant(report === `var/derived/germany-${targetPatch}/${HISTORICAL_TIMETABLE_ROUTE_REPORT_FILE}`, "Timetable-Reportpfad ist nicht kanonisch.");
  const migrated = {
    ...prefix,
    schema: target.compilerSchema,
    dailyCirculation: {
      rule: "lot-local-playable-path-cover-with-explicit-physical-transition-partition/v2",
      repeatEveryS: 86_400,
      minimumTurnaroundS: 300,
      ...target.dailyCirculation,
      formationLengthsMm: [...TURNAROUND_POLICY_V2.terminalFormationLengthsMm],
      unknownMainlineSpeedKmh: 20,
      unknownServiceSpeedKmh: 10,
    },
    output,
    transferOutput: `var/derived/germany-${targetPatch}/timetable-routes-v2.transfer-demands-v2.json`,
    report: `var/derived/germany-${targetPatch}/${TARGET_TIMETABLE_ROUTE_REPORT_FILE}`,
  };
  return `${JSON.stringify(migrated, null, 2)}\n`;
}

function migrateReleaseArtifacts(content, targetPatch) {
  timetableUpstreamTarget(targetPatch);
  const value = JSON.parse(content);
  invariant(value.schema === "zugfolge-infra-release-artifact-spec/v2", "InfraRelease-Artefaktvertrag besitzt nicht das erwartete v2-Schema.");
  invariant(Array.isArray(value.artifacts), "InfraRelease-Artefaktvertrag besitzt kein Artefaktinventar.");
  const operationalIndex = value.artifacts.findIndex(({ id, kind }) => (
    id === `operational-infrastructure-${targetPatch}` && kind === "operational-infrastructure-v2"
  ));
  const qualityIndex = value.artifacts.findIndex(({ id, kind }) => (
    id === `quality-report-${targetPatch}` && kind === "quality-report"
  ));
  invariant(
    operationalIndex >= 0 && qualityIndex === operationalIndex + 1,
    "InfraRelease-Artefaktvertrag besitzt nicht die unveraenderte historische Operational-/Quality-Reihenfolge.",
  );
  invariant(
    value.artifacts.every(({ id, kind }) => (
      id !== `operational-movement-routes-${targetPatch}`
        && id !== `timetable-transfer-demands-${targetPatch}`
        && kind !== "movement-route-templates-v2"
        && kind !== "timetable-transfer-demands-v1"
        && kind !== "timetable-transfer-demands-v2"
    )),
    "Unveraenderter InfraRelease-Artefaktvertrag darf noch keine Movement-/Transfer-Sidecars enthalten.",
  );
  value.artifacts.splice(
    operationalIndex + 1,
    0,
    {
      id: `operational-movement-routes-${targetPatch}`,
      kind: "movement-route-templates-v2",
      sourceFile: `var/derived/germany-${targetPatch}/operational-infrastructure-v2.movement-route-templates-v2.json`,
      file: "operational-infrastructure-v2.movement-route-templates-v2.json",
    },
    {
      id: `timetable-transfer-demands-${targetPatch}`,
      kind: "timetable-transfer-demands-v2",
      sourceFile: `var/derived/germany-${targetPatch}/timetable-routes-v2.transfer-demands-v2.json`,
      file: "timetable-routes-v2.transfer-demands-v2.json",
    },
  );
  return `${JSON.stringify(value, null, 2)}\n`;
}

function migrateSyntheticOperationalPolicy(content, targetPatch) {
  timetableUpstreamTarget(targetPatch);
  const value = JSON.parse(content);
  invariant(value.schema === "zugfolge-synthetic-operational-policy/v2", "Synthetic-Operational-Policy besitzt nicht das erwartete v2-Schema.");
  invariant(value.id === "synthetic-operational-b/v2", "Synthetic-Operational-Policy besitzt nicht die erwartete ID.");
  invariant(Array.isArray(value.requiredInputRoles), "Synthetic-Operational-Policy besitzt keine Eingaberollen.");
  invariant(
    !value.requiredInputRoles.includes("timetable-transfer-demands"),
    "Unveraenderte Synthetic-Operational-Policy darf Transfer-Demands noch nicht binden.",
  );
  const timetableRoutesRoleIndex = value.requiredInputRoles.indexOf("timetable-routes");
  invariant(
    timetableRoutesRoleIndex >= 0 && value.requiredInputRoles[timetableRoutesRoleIndex + 1] === "tracks",
    "Synthetic-Operational-Policy besitzt nicht die historische Timetable-Routes-/Tracks-Rollenfolge.",
  );
  value.requiredInputRoles = insertArrayValuesAfter(
    value.requiredInputRoles,
    "timetable-routes",
    ["timetable-transfer-demands"],
    "Synthetic-Operational-Policy.requiredInputRoles",
  );

  invariant(Array.isArray(value.requiredDimensions), "Synthetic-Operational-Policy besitzt keine Pflichtdimensionen.");
  invariant(
    !value.requiredDimensions.includes("daily-physical-circulations")
      && !value.requiredDimensions.includes("real-transfer-route-coverage"),
    "Unveraenderte Synthetic-Operational-Policy darf die Daily-/Transferdimensionen noch nicht binden.",
  );
  value.requiredDimensions = insertArrayValuesAfter(
    value.requiredDimensions,
    "complete-pinned-timetable-routes",
    ["daily-physical-circulations", "real-transfer-route-coverage"],
    "Synthetic-Operational-Policy.requiredDimensions",
  );

  invariant(Array.isArray(value.rules), "Synthetic-Operational-Policy besitzt keine Regeln.");
  invariant(
    value.rules.every(({ id }) => !String(id).startsWith("daily-physical-circulation-and-transfer-coverage/")),
    "Unveraenderte Synthetic-Operational-Policy darf noch keine Daily-/Transferregel enthalten.",
  );
  const pinnedRuleIndex = value.rules.findIndex(({ id }) => id === "pinned-timetable-route-coverage/v1");
  const provenanceRuleIndex = value.rules.findIndex(({ id }) => id === "free-gtfs-route-provenance/v2");
  invariant(
    pinnedRuleIndex >= 0 && provenanceRuleIndex === pinnedRuleIndex + 1,
    "Synthetic-Operational-Policy besitzt nicht die historische Routen-/Provenienz-Regelreihenfolge.",
  );
  invariant(
    value.rules[provenanceRuleIndex].effect.includes("v2 derivation report"),
    "Synthetic-Operational-Policy besitzt nicht den unveraenderten historischen V2-Reportbezug.",
  );
  value.rules.splice(pinnedRuleIndex + 1, 0, {
    id: "daily-physical-circulation-and-transfer-coverage/v2",
    effect: "Bind every planned passenger continuation to the explicit daily-plan-v2 partition exactly once: identical locationId and physicalStopId are turnarounds, every other transition is a transfer with a real directed OSM route and reproducible plan and transfer-set hashes.",
  });
  value.rules[provenanceRuleIndex + 1].effect = value.rules[provenanceRuleIndex + 1].effect.replace(
    "v2 derivation report",
    "v4 derivation report",
  );

  const compilerPolicy = jsonObject(value.compilerPolicy, "Synthetic-Operational-Compiler-Policy");
  invariant(
    compilerPolicy.minimumOverlapMm === 200_000,
    "Synthetic-Operational-Quellpolicy verletzt den historischen Overlap-Grundwert.",
  );
  requireAbsentProperties(compilerPolicy, Object.keys(TURNAROUND_POLICY_V2), "Synthetic-Operational-Compiler-Policy");
  value.compilerPolicy = insertObjectFieldsBefore(
    compilerPolicy,
    "defaultProtectionSystem",
    {
      ...TURNAROUND_POLICY_V2,
      terminalFormationLengthsMm: [...TURNAROUND_POLICY_V2.terminalFormationLengthsMm],
    },
    "Synthetic-Operational-Compiler-Policy",
  );
  invariant(
    value.compilerPolicy.rzueLayoutId === `rzue-deutschland-${targetPatch}-synthetic-b-v2`,
    "Synthetic-Operational-Policy besitzt nicht die erwartete Zielpatch-RZUE-ID.",
  );
  return `${JSON.stringify(value, null, 2)}\n`;
}

function migrateSyntheticOperationalClosure(content, targetPatch) {
  timetableUpstreamTarget(targetPatch);
  const value = JSON.parse(content);
  invariant(value.schema === "zugfolge-synthetic-operational-closure-inputs/v2", "Synthetic-Operational-Closure besitzt nicht das erwartete v2-Schema.");
  invariant(value.releaseId === `infra-deutschland-${targetPatch}`, "Synthetic-Operational-Closure besitzt nicht die erwartete Release-ID.");
  invariant(
    value.timetableRouteReportFile === HISTORICAL_TIMETABLE_ROUTE_REPORT_FILE,
    "Synthetic-Operational-Closure besitzt nicht die historische V2-Reportdatei.",
  );
  requireAbsentProperties(value, ["timetableTransferDemandsFile"], "Synthetic-Operational-Closure");
  value.timetableRouteReportFile = TARGET_TIMETABLE_ROUTE_REPORT_FILE;
  return `${JSON.stringify(insertObjectFieldsBefore(
    value,
    "gtfsSnapshotFile",
    { timetableTransferDemandsFile: "timetable-routes-v2.transfer-demands-v2.json" },
    "Synthetic-Operational-Closure",
  ), null, 2)}\n`;
}

function migrateMapPackage(content, targetPatch) {
  timetableUpstreamTarget(targetPatch);
  const value = JSON.parse(content);
  invariant(value.schema === "zugfolge-map-package-plan/v2", "Map-Package-Plan besitzt nicht das erwartete v2-Schema.");
  invariant(value.version === targetPatch, "Map-Package-Plan besitzt nicht die erwartete Zielversion.");
  requireAbsentProperties(
    value,
    ["operationalProvenanceSource", "operationalAuthoritySource"],
    "Map-Package-Plan",
  );
  invariant(Array.isArray(value.auxiliaryFiles), "Map-Package-Plan besitzt keine Zusatzdateien.");
  const operationalIndex = value.auxiliaryFiles.findIndex(({ id, kind }) => (
    id === `operational-infrastructure-${targetPatch}` && kind === "operational-infrastructure-v2"
  ));
  const styleIndex = value.auxiliaryFiles.findIndex(({ id, kind }) => id === "style-dark" && kind === "style");
  invariant(
    operationalIndex >= 0 && styleIndex === operationalIndex + 1,
    "Map-Package-Plan besitzt nicht die unveraenderte historische Operational-/Style-Reihenfolge.",
  );
  invariant(
    value.auxiliaryFiles.every(({ id, kind }) => (
      id !== `operational-movement-routes-${targetPatch}`
        && id !== `timetable-transfer-demands-${targetPatch}`
        && kind !== "movement-route-templates-v2"
        && kind !== "timetable-transfer-demands-v1"
        && kind !== "timetable-transfer-demands-v2"
    )),
    "Unveraenderter Map-Package-Plan darf noch keine Movement-/Transfer-Sidecars enthalten.",
  );
  const artifactInventory = `var/derived/germany-${targetPatch}/release-artifacts.v2.json`;
  value.auxiliaryFiles.splice(
    operationalIndex + 1,
    0,
    {
      id: `operational-movement-routes-${targetPatch}`,
      kind: "movement-route-templates-v2",
      visibility: "public",
      sourceFile: `var/derived/germany-${targetPatch}/operational-infrastructure-v2.movement-route-templates-v2.json`,
      installPath: "operational-infrastructure-v2.movement-route-templates-v2.json",
      artifactInventory,
    },
    {
      id: `timetable-transfer-demands-${targetPatch}`,
      kind: "timetable-transfer-demands-v2",
      visibility: "public",
      sourceFile: `var/derived/germany-${targetPatch}/timetable-routes-v2.transfer-demands-v2.json`,
      installPath: "timetable-routes-v2.transfer-demands-v2.json",
      artifactInventory,
    },
  );
  return `${JSON.stringify(insertObjectFieldsBefore(
    value,
    "artifacts",
    {
      operationalProvenanceSource: {
        publicationReceiptFile: `var/derived/germany-${targetPatch}/operational-infrastructure-v2.publication-receipt.json`,
      },
      operationalAuthoritySource: {
        buildEvidenceSpecFile: `tools/tiles/map-release-build-evidence.annual-${targetPatch}.spec.json`,
      },
    },
    "Map-Package-Plan",
  ), null, 2)}\n`;
}

function migrateReleaseConfig(content, targetPatch, operationalDependencySnapshot) {
  const target = timetableUpstreamTarget(targetPatch);
  invariant(operationalDependencySnapshot !== undefined,
    "Deutschland-Release-Konfiguration fehlt der gemeinsame Operational-v2-Dependency-Byte-Snapshot.");
  const value = JSON.parse(content);
  invariant(value.release?.releaseId === `infra-deutschland-${targetPatch}`, "Deutschland-Release-Konfiguration besitzt nicht die erwartete Zielrelease-ID.");
  const deriver = jsonObject(value.pipeline?.operationalDeriver, "OperationalDeriver");
  invariant(
    Object.keys(deriver).sort().join(",") === ["candidate", "entrypoint", "output", "report", "specification"].sort().join(","),
    "OperationalDeriver-Quellvertrag besitzt nicht die exakt migrierbare historische Form.",
  );
  invariant(deriver.entrypoint === "tools/region-import/germany/run-operational-infrastructure-v2.mjs", "OperationalDeriver-Quellvertrag besitzt einen falschen Runner.");
  value.pipeline.operationalDeriver = {
    primaryRunner: GERMANY_OPERATIONAL_EXECUTION_RUNNER_BUNDLE,
    primaryRunnerMode: "system-launcher-held-bundle-stdin-v1",
    systemCommandBuilder: GERMANY_OPERATIONAL_EXECUTION_COMMAND_BUILDER,
    systemCommandBuilderMode: GERMANY_OPERATIONAL_COMMAND_BUILDER_MODE,
    directSystemLaunch: {
      platform: "win32",
      contract: structuredClone(operationalDependencySnapshot.directSystemLaunchProof),
    },
    executionPins: `tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-${targetPatch}.json`,
    specification: deriver.specification,
    sourceRoot: ".",
    candidate: deriver.candidate,
    candidateMovementRouteTemplates: `var/derived/germany-${targetPatch}/operational-infrastructure-v2.candidate.movement-route-templates-v2.json`,
    report: deriver.report,
    output: deriver.output,
    recoveryPublisher: {
      captureEntrypoint: "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs",
      entrypoint: "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
      validatorExecutable: operationalValidatorSourceFile(targetPatch, target.operationalValidatorBuildCommit, target.operationalValidatorSha256),
      validatorBuildCommit: target.operationalValidatorBuildCommit,
      validatorBytes: target.operationalValidatorBytes,
      validatorSha256: target.operationalValidatorSha256,
      validatorRebuildSpecification: operationalValidatorRebuildSpecFile(targetPatch),
      validatorRebuildEvidence: operationalValidatorRebuildEvidenceFile(targetPatch),
      validatorRebuildExecutable: operationalValidatorRebuildSourceFile(targetPatch, target.operationalValidatorBuildCommit),
      validatorRebuildExpectedBytes: target.operationalValidatorRebuildExpectedBytes,
      validatorNormalizedPeSha256: target.operationalValidatorNormalizedPeSha256,
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
      nativeReceipt: `var/derived/germany-${targetPatch}/operational-infrastructure-v2.native-receipt.json`,
      outerExecutionReceipt: `var/derived/germany-${targetPatch}/operational-infrastructure-v2.outer-execution-receipt.json`,
      publicationReceipt: `var/derived/germany-${targetPatch}/operational-infrastructure-v2.publication-receipt.json`,
    },
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

function migrateBuildEvidence(content, sourcePatch, targetPatch) {
  const target = timetableUpstreamTarget(targetPatch);
  const value = JSON.parse(content);
  invariant(
    value.schema === "zugfolge-map-release-build-evidence-spec/v2",
    "Jahrespatch kann nur den vollstaendigen Build-Evidence-v2-Vertrag auf v3 migrieren.",
  );
  invariant(
    value.releaseId === `infra-deutschland-${targetPatch}`,
    "Build-Evidence-Zielvertrag besitzt nicht die erwartete Deutschland-Release-ID.",
  );
  invariant(Array.isArray(value.inputs), "Build-Evidence-Zielvertrag besitzt keine Eingaben.");
  const sourceReportBinding = timetableRouteReportEvidenceBinding(targetPatch, HISTORICAL_TIMETABLE_ROUTE_REPORT_FILE);
  const targetReportBinding = timetableRouteReportEvidenceBinding(targetPatch, TARGET_TIMETABLE_ROUTE_REPORT_FILE);
  const reportInputs = value.inputs.filter((entry) => (
    entry?.id === TIMETABLE_ROUTE_REPORT_INPUT_ID
      || isTimetableRouteReportPath(entry?.file)
      || isTimetableRouteReportPath(entry?.cacheFile)
  ));
  invariant(reportInputs.length === 1, "Build-Evidence-Zielvertrag bindet den historischen Timetable-Routenbericht nicht exakt einmal.");
  const reportInput = jsonObject(reportInputs[0], "Build-Evidence-Timetable-Routenbericht");
  invariant(
    Object.keys(reportInput).length === Object.keys(sourceReportBinding).length
      && Object.entries(sourceReportBinding).every(([key, expected]) => reportInput[key] === expected),
    "Build-Evidence-Zielvertrag besitzt keine exakt migrierbare historische V3-Reportbindung.",
  );
  reportInput.file = targetReportBinding.file;
  reportInput.cacheFile = targetReportBinding.cacheFile;

  const gtfsInputs = value.inputs.filter(({ id }) => id === "gtfs-region-snapshot");
  invariant(gtfsInputs.length === 1, "Build-Evidence-Zielvertrag bindet den GTFS-Region-Snapshot nicht exakt einmal.");
  const gtfsInput = jsonObject(gtfsInputs[0], "Build-Evidence-GTFS-Region-Snapshot");
  invariant(gtfsInput.kind === "derived-input", "Build-Evidence-GTFS-Region-Snapshot ist keine abgeleitete Eingabe.");
  positiveInteger(gtfsInput.expectedBytes, "Build-Evidence-GTFS-Region-Snapshot expectedBytes");
  sha256Pin(gtfsInput.expectedSha256, "Build-Evidence-GTFS-Region-Snapshot expectedSha256");
  gtfsInput.expectedBytes = target.snapshot.bytes;
  gtfsInput.expectedSha256 = target.snapshot.fileSha256;

  const candidatePackage = jsonObject(value.candidatePackage, "Build-Evidence-Kandidatenpaket");
  const retainedKeyIds = candidatePackage.retainedTrustedKeyIds;
  invariant(Array.isArray(retainedKeyIds) && retainedKeyIds.every((keyId) => typeof keyId === "string" && keyId.length > 0), "Build-Evidence-Retained-Keys sind ungueltig.");
  invariant(new Set(retainedKeyIds).size === retainedKeyIds.length, "Build-Evidence-Retained-Keys sind nicht eindeutig.");
  const previousMapKeyId = `zugfolge-map-deutschland-${sourcePatch}`;
  const targetMapKeyId = `zugfolge-map-deutschland-${targetPatch}`;
  invariant(!retainedKeyIds.includes(targetMapKeyId), "Der neue Delivery-Key darf nicht als beizubehaltender Alt-Key deklariert werden.");
  invariant(!retainedKeyIds.includes(previousMapKeyId), "Der vorherige Delivery-Key ist vor der Jahrespatch-Migration bereits eingemischt.");
  candidatePackage.retainedTrustedKeyIds = [...retainedKeyIds, previousMapKeyId].sort();

  invariant(Array.isArray(value.outputs), "Build-Evidence-Zielvertrag besitzt keine Ausgaben.");
  invariant(
    JSON.stringify(value.outputs.map(({ kind }) => kind)) === JSON.stringify(BUILD_EVIDENCE_V2_OUTPUT_KINDS),
    "Build-Evidence-v2-Zielvertrag besitzt kein exakt migrierbares Ausgabeinventar.",
  );
  value.schema = "zugfolge-map-release-build-evidence-spec/v3";
  for (const [id, file] of [
    ["operational-native-receipt", "operational-infrastructure-v2.native-receipt.json"],
    ["operational-publication-receipt", "operational-infrastructure-v2.publication-receipt.json"],
  ]) {
    invariant(value.inputs.every((entry) => entry.id !== id), `Build-Evidence-Zielvertrag enthaelt bereits ${id}.`);
    value.inputs.push({
      id,
      kind: "derived-input",
      version: `infra-deutschland-${targetPatch}`,
      file: `var/derived/germany-${targetPatch}/${file}`,
      cacheFile: `derived/infra-deutschland-${targetPatch}/${file}`,
    });
  }
  for (const authorityInput of REQUIRED_OPERATIONAL_AUTHORITY_INPUTS) {
    invariant(
      value.inputs.every((entry) => entry.id !== authorityInput.id),
      `Build-Evidence-Zielvertrag enthaelt bereits ${authorityInput.id}.`,
    );
    value.inputs.push({
      id: authorityInput.id,
      kind: "derived-input",
      version: `infra-deutschland-${targetPatch}`,
      file: `var/derived/germany-${targetPatch}/${authorityInput.fileName}`,
      cacheFile: `derived/infra-deutschland-${targetPatch}/${authorityInput.fileName}`,
      ...(authorityInput.expectedBytes === undefined ? {} : {
        expectedBytes: authorityInput.expectedBytes,
        expectedSha256: authorityInput.expectedSha256,
      }),
    });
  }
  invariant(value.inputs.every((entry) => entry.id !== "operational-validator-rebuild-evidence"), "Build-Evidence-Zielvertrag enthaelt bereits das Validator-Rebuild-Evidence.");
  value.inputs.push({
    id: "operational-validator-rebuild-evidence",
    kind: "derived-input",
    version: `infra-deutschland-${targetPatch}`,
    file: operationalValidatorRebuildEvidenceFile(targetPatch),
    cacheFile: operationalValidatorRebuildEvidenceCacheFile(targetPatch),
  });
  for (const [id, file] of [
    ["operational-native-receipt-capture", "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs"],
    ["operational-recovery-publisher", "tools/region-import/germany/publish-operational-infrastructure-v2.mjs"],
    ["operational-recovery-publisher-implementation", "tools/region-import/germany/operational-infrastructure-v2-publication.mjs"],
    ["operational-v2-deriver", "tools/region-import/germany/operational-infrastructure-v2.mjs"],
    ["operational-v2-materializer", "tools/region-import/materialize-operational-infrastructure-v2.mjs"],
    ["create-new-output-contract", "tools/tiles/create-new-output.mjs"],
    ["operational-v2-binding", "tools/region-import/operational-infrastructure-binding.mjs"],
    ["operational-validator-rebuild-bootstrap", "tools/region-import/germany/operational-validator-rebuild-bootstrap.mjs"],
    ["operational-validator-rebuild-spec", operationalValidatorRebuildSpecFile(targetPatch)],
    ["operational-validator-rebuild-verifier", "tools/region-import/germany/operational-validator-rebuild-evidence.mjs"],
    ["operational-validator-rebuild-cli", "tools/region-import/germany/operational-validator-rebuild-evidence-cli.mjs"],
  ]) {
    invariant(value.inputs.every((entry) => entry.id !== id), `Build-Evidence-Zielvertrag enthaelt bereits ${id}.`);
    value.inputs.push({ id, kind: "repo-contract", version: `infra-deutschland-${targetPatch}`, file });
  }
  invariant(Array.isArray(value.tools), "Build-Evidence-Zielvertrag besitzt kein Werkzeuginventar.");
  invariant(value.tools.every(({ id }) => id !== "operational-v2-validator"), "Build-Evidence-Zielvertrag enthaelt bereits den Operational-v2-Validator.");
  value.tools.unshift({
    id: "operational-v2-validator",
    kind: "binary",
    version: OPERATIONAL_VALIDATOR_BUILD_COMMIT_VERSION,
    file: operationalValidatorSourceFile(targetPatch, target.operationalValidatorBuildCommit, target.operationalValidatorSha256),
    cacheFile: operationalValidatorCacheFile(targetPatch, target.operationalValidatorBuildCommit, target.operationalValidatorSha256),
    expectedBytes: target.operationalValidatorBytes,
    expectedSha256: target.operationalValidatorSha256,
  });
  value.tools.splice(1, 0, {
    id: "operational-v2-validator-rebuild",
    kind: "binary",
    version: "operational-validator-rebuild-proof",
    file: operationalValidatorRebuildSourceFile(targetPatch, target.operationalValidatorBuildCommit),
    cacheFile: operationalValidatorRebuildCacheFile(targetPatch, target.operationalValidatorBuildCommit),
  });
  value.outputs.push(
    {
      id: "operational-movement-routes",
      kind: "movement-route-templates-v2",
      file: `var/derived/germany-${targetPatch}/operational-infrastructure-v2.movement-route-templates-v2.json`,
      installFile: "operational-infrastructure-v2.movement-route-templates-v2.json",
    },
    {
      id: "timetable-transfer-demands",
      kind: "timetable-transfer-demands-v2",
      file: `var/derived/germany-${targetPatch}/timetable-routes-v2.transfer-demands-v2.json`,
      installFile: "timetable-routes-v2.transfer-demands-v2.json",
    },
  );
  return `${JSON.stringify(value, null, 2)}\n`;
}

function migrateAlphaWorldRuntimeStructure(content, targetPatch) {
  invariant(!content.includes("releaseBoundAlphaWorldBuilderInputs"), "Alpha-Real-Audit-Quelle enthaelt bereits den target-only Sidecar-Harnisch.");
  let migrated = replaceTextExactlyOnce(
    content,
    'import { buildAlphaWorld } from "../region-import/build-alpha-world.mjs";',
    `import {\n  buildAlphaWorld,\n  validateAlphaWorldBuildConfiguration,\n} from "../region-import/build-alpha-world.mjs";`,
    "Alpha-Builder-Import",
  );
  migrated = replaceTextExactlyOnce(
    migrated,
    'const POSTGRES_DATABASE_NAME = /^zugfolge_germany_e2e_[a-z0-9_]+$/u;',
    `const POSTGRES_DATABASE_NAME = /^zugfolge_germany_e2e_[a-z0-9_]+$/u;\nconst TIMETABLE_TRANSFER_DEMANDS_FILE = "timetable-routes-v2.transfer-demands-v2.json";\nconst MOVEMENT_ROUTE_TEMPLATES_FILE = "operational-infrastructure-v2.movement-route-templates-v2.json";`,
    "Alpha-Sidecar-Dateikonstanten",
  );

  const builderInputHelper = `async function releaseBoundAlphaWorldBuilderInputs(artifactRoot, outputPath) {
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
}`;
  migrated = replaceTextExactlyOnce(
    migrated,
    "\n\nasync function runtimeBuildProof(",
    `\n\n${builderInputHelper}\n\nasync function runtimeBuildProof(`,
    "Alpha-Sidecar-Builder-Helfer",
  );

  const builderHarnessTest = `test("Alpha-Builder-Harnisch reicht beide realen Sidecars positions- und hashgebunden weiter", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "zugfolge-germany-builder-sidecars-"));
  try {
    const transferPath = join(artifactRoot, TIMETABLE_TRANSFER_DEMANDS_FILE);
    const movementPath = join(artifactRoot, MOVEMENT_ROUTE_TEMPLATES_FILE);
    await Promise.all([
      writeFile(transferPath, '{"schema":"zugfolge-timetable-transfer-demands/v2"}\\n', { flag: "wx" }),
      writeFile(movementPath, '{"schema":"movement-route-templates-v2"}\\n', { flag: "wx" }),
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
      }, null, 2) + "\\n",
      { encoding: "utf8", flag: "wx" },
    );
    const outputPath = join(artifactRoot, "alpha-world-deployment.${targetPatch}.json");
    const inputs = await releaseBoundAlphaWorldBuilderInputs(artifactRoot, outputPath);
    assert.deepEqual(inputs.argv.slice(9, 11), [transferPath, movementPath]);
    assert.deepEqual(inputs.sidecars.timetableTransferDemands, {
      file: TIMETABLE_TRANSFER_DEMANDS_FILE,
      ...transferProof,
    });
    assert.equal(inputs.sidecars.movementRouteTemplates.sha256, movementProof.sha256);

    await writeFile(movementPath, '{"schema":"movement-route-templates-v2","tampered":true}\\n');
    await assert.rejects(
      releaseBoundAlphaWorldBuilderInputs(artifactRoot, outputPath),
      /Movement-Route-Templates-v2-Sidecar verletzt/u,
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});`;
  migrated = replaceTextExactlyOnce(
    migrated,
    '\ntest("Top-level-Akzeptanz bleibt ohne exakten Linux-cgroup-v2-No-Swap-Beleg rot", () => {',
    `\n${builderHarnessTest}\n\ntest("Top-level-Akzeptanz bleibt ohne exakten Linux-cgroup-v2-No-Swap-Beleg rot", () => {`,
    "Alpha-Sidecar-Builder-Test",
  );

  const oldBuilderInvocation = `    const builderResult = reuseDeployments || reuseUnsignedDeployment
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
      ]);`;
  const newBuilderInvocation = `    const builderInputs = await releaseBoundAlphaWorldBuilderInputs(artifactRoot, unsignedPath);
    const builderResult = reuseDeployments || reuseUnsignedDeployment
      ? undefined
      : await buildAlphaWorld(builderInputs.argv);`;
  migrated = replaceTextExactlyOnce(
    migrated,
    oldBuilderInvocation,
    newBuilderInvocation,
    "Alpha-Real-Builder-Aufruf",
  );
  migrated = replaceTextExactlyOnce(
    migrated,
    "        operationalTrainCount: unsigned.deployment.regionalSimulation.trains.length,\n      },\n      runtimeBuild,\n      authorityRendering,",
    "        operationalTrainCount: unsigned.deployment.regionalSimulation.trains.length,\n      },\n      builderSidecars: builderInputs.sidecars,\n      runtimeBuild,\n      authorityRendering,",
    "Alpha-Real-Evidence-Sidecars",
  );
  return migrated;
}

function migrateAlphaWorldRuntimeAudit(content, targetPatch) {
  let migrated = migrateAlphaWorldRuntimeStructure(content, targetPatch);
  migrated = replaceExactlyOnce(
    migrated,
    /const EXPECTED_ALPHA_DEPLOYMENT_HASH = "[a-f0-9]{64}";/u,
    `const EXPECTED_ALPHA_DEPLOYMENT_HASH = "${PENDING_REAL_BUILD}";`,
    "Alpha-Deployment-Hash-Pin",
  );
  for (const name of ["EXPECTED_ALPHA_UNSIGNED_DEPLOYMENT", "EXPECTED_ALPHA_SIGNED_DEPLOYMENT"]) {
    migrated = replaceObjectFreeze(migrated, name, (block) => {
      let pending = replaceExactlyOnce(block, /  bytes: [1-9][0-9_]*/u, "  bytes: 0", `${name} Byte-Pin`);
      pending = replaceExactlyOnce(pending, /  sha256: "[a-f0-9]{64}"/u, `  sha256: "${PENDING_REAL_BUILD}"`, `${name} SHA-256-Pin`);
      return pending;
    });
  }
  migrated = replaceExactlyOnce(
    migrated,
    /const EXPECTED_ALPHA_TYPESCRIPT_BUILD_SET_SHA256 = "[a-f0-9]{64}";/u,
    `const EXPECTED_ALPHA_TYPESCRIPT_BUILD_SET_SHA256 = "${PENDING_REAL_BUILD}";`,
    "Alpha-TypeScript-Build-Set-Pin",
  );
  migrated = replaceObjectFreeze(migrated, "EXPECTED_INFRA_BINDING", (block) => {
    let pending = replaceExactlyOnce(block, /  bytes: [1-9][0-9_]*/u, "  bytes: 0", "Alpha-Infra-Binding Byte-Pin");
    pending = replaceExactlyOnce(pending, /  sha256: "[a-f0-9]{64}"/u, `  sha256: "${PENDING_REAL_BUILD}"`, "Alpha-Infra-Binding SHA-256-Pin");
    pending = replaceExactlyOnce(pending, /  stateHash: "[a-f0-9]{64}"/u, `  stateHash: "${PENDING_REAL_BUILD}"`, "Alpha-Infra-Binding State-Hash-Pin");
    return pending;
  });
  return withPendingAuditGuard(migrated, "Deutschland-Alpha-Real-Audit", targetPatch);
}

function migrateSignedGameStagingAudit(content, sourcePatch, targetPatch) {
  let migrated = replaceExactlyOnce(
    content,
    /      operationalStateHash: "[a-f0-9]{64}",/u,
    `      operationalStateHash: "${PENDING_REAL_BUILD}",`,
    "Signed-Game-Staging Operational-State-Hash-Pin",
  );
  const sourceMinor = sourcePatch.split(".").at(-1);
  const targetMinor = targetPatch.split(".").at(-1);
  migrated = replaceTextExactlyOnce(
    migrated,
    `Erwartete .${sourceMinor}-Manifestbytezahl ist ungueltig.`,
    `Erwartete .${targetMinor}-Manifestbytezahl ist ungueltig.`,
    "Signed-Game-Staging Byte-Pin-Meldung",
  );
  migrated = replaceTextExactlyOnce(
    migrated,
    `Erwarteter .${sourceMinor}-Manifest-SHA-256 ist ungueltig.`,
    `Erwarteter .${targetMinor}-Manifest-SHA-256 ist ungueltig.`,
    "Signed-Game-Staging SHA-Pin-Meldung",
  );
  invariant(!migrated.includes(`Erwartete .${sourceMinor}-Manifest`), "Signed-Game-Staging enthaelt weiterhin die alte Byte-Pin-Meldung.");
  invariant(!migrated.includes(`Erwarteter .${sourceMinor}-Manifest`), "Signed-Game-Staging enthaelt weiterhin die alte SHA-Pin-Meldung.");

  const targetMapKeyId = `zugfolge-map-deutschland-${targetPatch}`;
  const previousMapKeyId = `zugfolge-map-deutschland-${sourcePatch}`;
  const targetKeyAssertion = `  assert.ok(parsed["${targetMapKeyId}"], "Der Deutschland-${targetPatch}-Delivery-Key fehlt im Trust-Register.");`;
  const previousKeyAssertion = `${targetKeyAssertion}\n  assert.ok(\n    Object.hasOwn(parsed, "${previousMapKeyId}"),\n    "Der vorherige Deutschland-${sourcePatch}-Delivery-Key muss fuer Rollback und Altartefakte im Trust-Register bleiben.",\n  );`;
  migrated = replaceTextExactlyOnce(
    migrated,
    targetKeyAssertion,
    previousKeyAssertion,
    "Signed-Game-Staging Ziel-Key-Assertion",
  );
  return withPendingAuditGuard(migrated, "Deutschland-Signed-Game-Staging-Audit", targetPatch);
}

async function migrateTargetContract(content, template, sourcePatch, targetPatch, operationalDependencySnapshot) {
  if (template === BUILD_CACHE_INVENTORY_TEMPLATE) {
    const target = timetableUpstreamTarget(targetPatch);
    const value = JSON.parse(content);
    const releaseId = `infra-deutschland-${targetPatch}`;
    validateMapBuildCacheInventoryPlan(value, releaseId);
    const sourceReportBinding = timetableRouteReportCacheBinding(targetPatch, HISTORICAL_TIMETABLE_ROUTE_REPORT_FILE);
    const targetReportBinding = timetableRouteReportCacheBinding(targetPatch, TARGET_TIMETABLE_ROUTE_REPORT_FILE);
    const reportEntries = value.files.filter((entry) => (
      isTimetableRouteReportPath(entry?.sourceFile) || isTimetableRouteReportPath(entry?.cacheFile)
    ));
    invariant(reportEntries.length === 1, "Buildcache-Zielvertrag bindet den historischen Timetable-Routenbericht nicht exakt einmal.");
    const reportEntry = jsonObject(reportEntries[0], "Buildcache-Timetable-Routenbericht");
    invariant(
      Object.keys(reportEntry).length === Object.keys(sourceReportBinding).length
        && Object.entries(sourceReportBinding).every(([key, expected]) => reportEntry[key] === expected),
      "Buildcache-Zielvertrag besitzt keine exakt migrierbare historische V3-Reportbindung.",
    );
    reportEntry.sourceFile = targetReportBinding.sourceFile;
    reportEntry.cacheFile = targetReportBinding.cacheFile;
    for (const required of REQUIRED_OPERATIONAL_CACHE_SIDECARS) {
      const sourceFile = required.sourceFile(targetPatch);
      const cacheFile = required.cacheFile(targetPatch);
      invariant(
        value.files.every((entry) => entry.sourceFile.split("/").at(-1) !== required.fileName),
        `Buildcache-Zielvertrag enthaelt bereits das Sidecar ${required.name}.`,
      );
      invariant(
        value.files.every((entry) => entry.cacheFile.split("/").at(-1) !== required.fileName),
        `Buildcache-Zielvertrag enthaelt bereits einen Cachepfad fuer ${required.name}.`,
      );
      value.files.push({ sourceFile, cacheFile });
    }
    for (const fileName of REQUIRED_OPERATIONAL_RECOVERY_RECEIPTS) {
      invariant(value.files.every(({ sourceFile, cacheFile }) => !sourceFile.endsWith(`/${fileName}`) && !cacheFile.endsWith(`/${fileName}`)), `Buildcache-Zielvertrag enthaelt bereits ${fileName}.`);
      value.files.splice(value.files.length - REQUIRED_OPERATIONAL_CACHE_SIDECARS.length, 0, {
        sourceFile: `var/derived/germany-${targetPatch}/${fileName}`,
        cacheFile: `derived/infra-deutschland-${targetPatch}/${fileName}`,
      });
    }
    for (const authorityInput of REQUIRED_OPERATIONAL_AUTHORITY_INPUTS) {
      const sourceFile = `var/derived/germany-${targetPatch}/${authorityInput.fileName}`;
      const cacheFile = `derived/infra-deutschland-${targetPatch}/${authorityInput.fileName}`;
      invariant(
        value.files.every((entry) => entry.sourceFile !== sourceFile && entry.cacheFile !== cacheFile),
        `Buildcache-Zielvertrag enthaelt bereits ${authorityInput.id}.`,
      );
      value.files.splice(value.files.length - REQUIRED_OPERATIONAL_CACHE_SIDECARS.length, 0, {
        sourceFile,
        cacheFile,
      });
    }
    invariant(
      value.files.every(({ sourceFile, cacheFile }) => (
        sourceFile !== operationalValidatorRebuildEvidenceFile(targetPatch)
          && cacheFile !== operationalValidatorRebuildEvidenceCacheFile(targetPatch)
      )),
      "Buildcache-Zielvertrag enthaelt bereits das Validator-Rebuild-Evidence.",
    );
    value.files.push({
      sourceFile: operationalValidatorRebuildEvidenceFile(targetPatch),
      cacheFile: operationalValidatorRebuildEvidenceCacheFile(targetPatch),
    });
    const sourceArchiveFile = operationalValidatorSourceArchiveFile(
      targetPatch,
      target.operationalValidatorBuildCommit,
      target.operationalValidatorSourceArchive.sha256,
    );
    const sourceArchiveCacheFile = operationalValidatorSourceArchiveCacheFile(
      targetPatch,
      target.operationalValidatorBuildCommit,
      target.operationalValidatorSourceArchive.sha256,
    );
    const rebuildProvenanceFile = operationalValidatorRebuildProvenanceFile(
      targetPatch,
      target.operationalValidatorBuildCommit,
    );
    const rebuildProvenanceCacheFile = operationalValidatorRebuildProvenanceCacheFile(
      targetPatch,
      target.operationalValidatorBuildCommit,
    );
    invariant(
      value.files.every(({ sourceFile, cacheFile }) => (
        sourceFile !== sourceArchiveFile
          && cacheFile !== sourceArchiveCacheFile
          && sourceFile !== rebuildProvenanceFile
          && cacheFile !== rebuildProvenanceCacheFile
      )),
      "Buildcache-Zielvertrag enthaelt bereits ein portables Validator-Rebuild-Artefakt.",
    );
    value.files.push({
      sourceFile: sourceArchiveFile,
      cacheFile: sourceArchiveCacheFile,
    });
    value.files.push({
      sourceFile: rebuildProvenanceFile,
      cacheFile: rebuildProvenanceCacheFile,
    });
    invariant(
      value.files.every(({ sourceFile, cacheFile }) => (
        sourceFile !== operationalValidatorSourceFile(targetPatch, target.operationalValidatorBuildCommit, target.operationalValidatorSha256)
          && cacheFile !== operationalValidatorCacheFile(targetPatch, target.operationalValidatorBuildCommit, target.operationalValidatorSha256)
          && sourceFile !== operationalValidatorRebuildSourceFile(targetPatch, target.operationalValidatorBuildCommit)
          && cacheFile !== operationalValidatorRebuildCacheFile(targetPatch, target.operationalValidatorBuildCommit)
      )),
      "Buildcache-Zielvertrag enthaelt bereits ein Operational-v2-Validator-Binary.",
    );
    value.files.push({
      sourceFile: operationalValidatorSourceFile(targetPatch, target.operationalValidatorBuildCommit, target.operationalValidatorSha256),
      cacheFile: operationalValidatorCacheFile(targetPatch, target.operationalValidatorBuildCommit, target.operationalValidatorSha256),
    });
    value.files.push({
      sourceFile: operationalValidatorRebuildSourceFile(targetPatch, target.operationalValidatorBuildCommit),
      cacheFile: operationalValidatorRebuildCacheFile(targetPatch, target.operationalValidatorBuildCommit),
    });
    validateMapBuildCacheInventoryPlan(value, releaseId);
    for (const required of REQUIRED_OPERATIONAL_CACHE_SIDECARS) {
      const expected = {
        sourceFile: required.sourceFile(targetPatch),
        cacheFile: required.cacheFile(targetPatch),
      };
      invariant(
        value.files.filter((entry) => entry.sourceFile === expected.sourceFile && entry.cacheFile === expected.cacheFile).length === 1,
        `Buildcache-Zielvertrag bindet ${required.name} nicht exakt einmal an den kanonischen Cachepfad.`,
      );
    }
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  if (template === OPERATIONAL_INFRASTRUCTURE_TEMPLATE) return migrateOperationalInfrastructure(content, targetPatch);
  if (template === OPERATIONAL_EXECUTION_PINS_TEMPLATE) {
    invariant(operationalDependencySnapshot !== undefined,
      "Operational-v2-Execution-Pins fehlen im gemeinsamen Dependency-Byte-Snapshot.");
    return operationalDependencySnapshot.executionPinsContent;
  }
  if (template === OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_TEMPLATE) {
    invariant(operationalDependencySnapshot !== undefined,
      "Operational-v2-Direct-System-Launch fehlt im gemeinsamen Dependency-Byte-Snapshot.");
    return operationalDependencySnapshot.directSystemLaunchContent;
  }
  if (template === OPERATIONAL_VALIDATOR_REBUILD_TEMPLATE) {
    return createOperationalValidatorRebuildSpecification(targetPatch, operationalDependencySnapshot);
  }
  if (template === RELEASE_CONFIG_TEMPLATE) return migrateReleaseConfig(content, targetPatch, operationalDependencySnapshot);
  if (template === RELEASE_ARTIFACTS_TEMPLATE) return migrateReleaseArtifacts(content, targetPatch);
  if (template === SYNTHETIC_OPERATIONAL_POLICY_TEMPLATE) return migrateSyntheticOperationalPolicy(content, targetPatch);
  if (template === SYNTHETIC_OPERATIONAL_CLOSURE_TEMPLATE) return migrateSyntheticOperationalClosure(content, targetPatch);
  if (template === TIMETABLE_ROUTE_COMPILER_TEMPLATE) return migrateTimetableRouteCompiler(content, targetPatch);
  if (template === MAP_PACKAGE_TEMPLATE) return migrateMapPackage(content, targetPatch);
  if (template === BUILD_EVIDENCE_TEMPLATE) return migrateBuildEvidence(content, sourcePatch, targetPatch);
  if (template === ALPHA_WORLD_RUNTIME_AUDIT_TEMPLATE) return migrateAlphaWorldRuntimeAudit(content, targetPatch);
  if (template === SIGNED_GAME_STAGING_AUDIT_TEMPLATE) return migrateSignedGameStagingAudit(content, sourcePatch, targetPatch);
  return content;
}

function ownedIdentity(metadata, includeSize = false) {
  const identity = { dev: metadata.dev, ino: metadata.ino };
  if (includeSize) identity.size = metadata.size;
  return identity;
}

function sameOwnedIdentity(metadata, identity) {
  return metadata.dev === identity.dev
    && metadata.ino === identity.ino
    && (!Object.hasOwn(identity, "size") || metadata.size === identity.size);
}

async function createOwnedFile(path, mode, openCreateNewFile) {
  const handle = await openCreateNewFile(path, "wx", mode);
  let metadata;
  try {
    metadata = await handle.stat({ bigint: true });
    invariant(metadata.isFile(), `Create-new-Datei ist keine regulaere Datei: ${path}`);
  } catch (error) {
    const cleanupErrors = [];
    try {
      await handle.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    throw combinedOperationError(error, cleanupErrors);
  }
  return {
    closed: false,
    handle,
    identity: ownedIdentity(metadata),
    path,
  };
}

async function closeOwnedFile(owned) {
  if (owned.closed) return;
  owned.closed = true;
  await owned.handle.close();
}

async function writeAndSyncOwnedFile(owned, content) {
  try {
    await owned.handle.writeFile(content, "utf8");
    await owned.handle.sync();
  } finally {
    await closeOwnedFile(owned);
  }
  const metadata = await lstat(owned.path, { bigint: true });
  invariant(sameOwnedIdentity(metadata, owned.identity), `Create-new-Datei wechselte waehrend des Schreibens ihre Identitaet: ${owned.path}`);
  const expectedBytes = BigInt(Buffer.byteLength(content, "utf8"));
  invariant(metadata.size === expectedBytes, `Create-new-Datei ist nach fsync nicht bytevollstaendig: ${owned.path}`);
  owned.identity = ownedIdentity(metadata, true);
}

async function removeOwnedFile(owned, hooks = {}) {
  await closeOwnedFile(owned).catch(() => {});
  let metadata;
  try {
    metadata = await lstat(owned.path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  invariant(
    sameOwnedIdentity(metadata, owned.identity),
    `Identitaetsgebundene Bereinigung verweigert eine fremde oder veraenderte Datei: ${owned.path}`,
  );
  if (hooks.beforeOwnedFileQuarantine !== undefined) await hooks.beforeOwnedFileQuarantine({ owned });
  const quarantineRoot = await mkdtemp(join(dirname(owned.path), ".annual-patch-owned-cleanup-"));
  const quarantined = join(quarantineRoot, "owned-file");
  await rename(owned.path, quarantined);
  const moved = await lstat(quarantined, { bigint: true });
  if (!sameOwnedIdentity(moved, owned.identity)) {
    try {
      await rename(quarantined, owned.path);
      await rmdir(quarantineRoot);
    } catch (restoreError) {
      throw new AggregateError(
        [restoreError],
        `Fremde Ersatzdatei bleibt nach identitaetsabweichender Quarantaene erhalten: ${quarantined}`,
      );
    }
    throw new Error(`Identitaetsgebundene Bereinigung hat eine fremde Ersatzdatei erkannt und wiederhergestellt: ${owned.path}`);
  }
  if (hooks.beforeOwnedFileFinalUnlink !== undefined) await hooks.beforeOwnedFileFinalUnlink({ owned, quarantined });
  const final = await lstat(quarantined, { bigint: true });
  if (!sameOwnedIdentity(final, owned.identity)) {
    try {
      await rename(quarantined, owned.path);
      await rmdir(quarantineRoot);
    } catch (restoreError) {
      throw new AggregateError(
        [restoreError],
        `Fremde Ersatzdatei bleibt nach finaler identitaetsabweichender Quarantaene erhalten: ${quarantined}`,
      );
    }
    throw new Error(`Identitaetsgebundene Bereinigung hat eine fremde Ersatzdatei unmittelbar vor dem Unlink erkannt und wiederhergestellt: ${owned.path}`);
  }
  await unlink(quarantined);
  await rmdir(quarantineRoot);
}

async function cleanupOwnedFiles(files, hooks = {}) {
  const errors = [];
  for (const owned of [...files].reverse()) {
    try {
      await removeOwnedFile(owned, hooks);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function combinedOperationError(operationError, cleanupErrors) {
  if (operationError === undefined && cleanupErrors.length === 0) return undefined;
  if (cleanupErrors.length === 0) return operationError;
  const causes = operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors];
  return new AggregateError(
    causes,
    `${operationError instanceof Error ? operationError.message : "Jahresrelease-Verarbeitung fehlgeschlagen."} Identitaetsgebundene Bereinigung meldete ${cleanupErrors.length} Fehler.`,
  );
}

async function invokeAnnualPatchHook(hooks, name, payload) {
  const hook = hooks[name];
  if (hook === undefined) return;
  invariant(typeof hook === "function", `Jahresrelease-Hook ${name} ist keine Funktion.`);
  await hook(payload);
}

async function verifyOperationalDependencyByteSnapshot(repositoryRoot, snapshot) {
  for (const expected of snapshot.dependencyProofs) {
    const actual = await operationalExecutionFileProof(repositoryRoot, expected.file);
    invariant(
      actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
      `Operational-v2-Dependency-Byte-Snapshot driftete vor der Veroeffentlichung: ${expected.file}`,
    );
  }
}

async function readOwnedBytesForCrossCheck(owned) {
  const handle = await open(owned.path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && sameOwnedIdentity(before, owned.identity),
      `Jahresrelease-Stagingdatei besitzt vor dem Byte-Cross-Check nicht mehr die vorbereitete Identitaet: ${owned.path}`);
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(owned.path, { bigint: true })]);
    invariant(after.isFile() && pathAfter.isFile()
      && sameOwnedIdentity(after, owned.identity) && sameOwnedIdentity(pathAfter, owned.identity)
      && before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && BigInt(bytes.length) === after.size,
    `Jahresrelease-Stagingdatei driftete waehrend des Byte-Cross-Checks: ${owned.path}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function exactJson(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => exactJson(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return left === right;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && exactJson(left[key], right[key]));
}

function operationalPreparedTargetCrossCheck(stagedBytesByTemplate, snapshot, targetPatch) {
  const executionPinsFile = contractPath(OPERATIONAL_EXECUTION_PINS_TEMPLATE, targetPatch);
  const directSystemLaunchFile = contractPath(OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_TEMPLATE, targetPatch);
  const snapshotExecutionPinsBytes = Buffer.from(snapshot.executionPinsContent, "utf8");
  const snapshotDirectSystemLaunchBytes = Buffer.from(snapshot.directSystemLaunchContent, "utf8");
  const executionPinsBytes = stagedBytesByTemplate.get(OPERATIONAL_EXECUTION_PINS_TEMPLATE)
    ?? snapshotExecutionPinsBytes;
  const directSystemLaunchBytes = stagedBytesByTemplate.get(OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_TEMPLATE)
    ?? snapshotDirectSystemLaunchBytes;
  invariant(executionPinsBytes.equals(snapshotExecutionPinsBytes),
    "Vorbereitete Operational-v2-Execution-Pins driften vom gemeinsamen Dependency-Byte-Snapshot.");
  invariant(directSystemLaunchBytes.equals(snapshotDirectSystemLaunchBytes),
    "Vorbereiteter Operational-v2-Direct-System-Launch driftet vom gemeinsamen Dependency-Byte-Snapshot.");

  const executionPins = validateGermanyOperationalExecutionPins(
    JSON.parse(executionPinsBytes.toString("utf8")),
    `infra-deutschland-${targetPatch}`,
  );
  const expectedAnchorHelper = snapshot.dependencyProofs.find(
    ({ file }) => file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
  );
  invariant(expectedAnchorHelper !== undefined
    && exactJson(executionPins.runner.anchorHelper, expectedAnchorHelper)
    && executionPins.runner.importClosure.filter(
      ({ file }) => file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
    ).length === 1
    && exactJson(
      executionPins.runner.importClosure.find(
        ({ file }) => file === GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
      ),
      expectedAnchorHelper,
    ),
  "Vorbereitete Execution-Pins binden den getrackten Anchor-Helper nicht bytegenau und exakt einmal in der Import-Closure.");
  const parsedDirectSystemLaunch = JSON.parse(directSystemLaunchBytes.toString("utf8"));
  invariant(exactJson(parsedDirectSystemLaunch.dynamicBindings, GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_BINDINGS),
    "Vorbereiteter Direct-System-Launch bindet nicht die kanonischen dynamischen Bindings.");
  const directSystemLaunch = validateGermanyOperationalDirectSystemLaunchContract({
    ...parsedDirectSystemLaunch,
    dynamicBindings: structuredClone(GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_BINDINGS),
  });
  const expectedExecutionPinsProof = {
    file: executionPinsFile,
    bytes: executionPinsBytes.length,
    sha256: createHash("sha256").update(executionPinsBytes).digest("hex"),
    schema: GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
  };
  invariant(directSystemLaunch.releaseId === executionPins.releaseId
    && exactJson(directSystemLaunch.executionPins, expectedExecutionPinsProof),
  "Vorbereiteter Direct-System-Launch bindet nicht exakt die vorbereiteten Execution-Pins-Bytes.");
  const expectedTrustedExecutor = {
    file: executionPins.validator.file,
    buildCommit: executionPins.validator.buildCommit,
    bytes: executionPins.validator.bytes,
    sha256: executionPins.validator.sha256,
  };
  invariant(exactJson(directSystemLaunch.trustedExecutor, expectedTrustedExecutor),
    "Vorbereiteter Direct-System-Launch bindet nicht exakt den Validator aus den vorbereiteten Execution-Pins.");
  const expectedDirectProof = {
    file: directSystemLaunchFile,
    bytes: directSystemLaunchBytes.length,
    sha256: createHash("sha256").update(directSystemLaunchBytes).digest("hex"),
    schema: GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA,
    releaseId: directSystemLaunch.releaseId,
    executionPins: structuredClone(directSystemLaunch.executionPins),
    trustedExecutor: structuredClone(directSystemLaunch.trustedExecutor),
  };
  invariant(exactJson(snapshot.directSystemLaunchProof, expectedDirectProof),
    "Gemeinsamer Dependency-Byte-Snapshot bindet einen anderen Direct-System-Launch-Proof.");

  const rebuildSpecificationBytes = stagedBytesByTemplate.get(OPERATIONAL_VALIDATOR_REBUILD_TEMPLATE);
  if (rebuildSpecificationBytes !== undefined) {
    const rebuildSpecification = JSON.parse(rebuildSpecificationBytes.toString("utf8"));
    const expectedSnapshotProof = (file) => snapshot.dependencyProofs.find((proof) => proof.file === file);
    const expectedExecutionPinsProducerProof = {
      bytes: executionPinsBytes.length,
      file: executionPinsFile,
      sha256: createHash("sha256").update(executionPinsBytes).digest("hex"),
    };
    invariant(
      exactJson(rebuildSpecification.toolchain?.anchor?.helperAssembly, expectedAnchorHelper)
        && exactJson(rebuildSpecification.producer?.bundle, expectedSnapshotProof(OPERATIONAL_EXECUTION_RUNNER_BUNDLE))
        && exactJson(rebuildSpecification.producer?.entrypoint, expectedSnapshotProof(OPERATIONAL_EXECUTION_RUNNER_ENTRYPOINT))
        && exactJson(rebuildSpecification.producer?.executionPins, expectedExecutionPinsProducerProof)
        && exactJson(
          rebuildSpecification.producer?.implementation,
          expectedSnapshotProof("tools/region-import/germany/operational-validator-rebuild-evidence.mjs"),
        ),
      "Vorbereiteter Operational-Validator-Rebuild-v3 bindet nicht exakt denselben Dependency-Byte-Snapshot wie Execution-Pins, Direct-Contract und Release-Config.",
    );
  }

  const releaseConfigBytes = stagedBytesByTemplate.get(RELEASE_CONFIG_TEMPLATE);
  if (releaseConfigBytes === undefined) return;
  const releaseConfig = JSON.parse(releaseConfigBytes.toString("utf8"));
  const deriver = releaseConfig.pipeline?.operationalDeriver;
  invariant(deriver?.executionPins === executionPinsFile
    && deriver.directSystemLaunch?.platform === "win32"
    && exactJson(deriver.directSystemLaunch.contract, expectedDirectProof),
  "Vorbereitete Release-Config bindet Execution-Pins und Direct-System-Launch nicht bytegenau.");
}

async function stagedTargetBytesCrossCheck(prepared, staged) {
  invariant(prepared.length === staged.length, "Jahresrelease-Staging ist fuer den Byte-Cross-Check unvollstaendig.");
  const byTemplate = new Map();
  for (const [index, contract] of prepared.entries()) {
    const bytes = await readOwnedBytesForCrossCheck(staged[index]);
    invariant(bytes.equals(Buffer.from(contract.content, "utf8")),
      `Jahresrelease-Stagingbytes driften vom vorbereiteten Zielvertrag: ${contract.template}`);
    byTemplate.set(contract.template, bytes);
  }
  return byTemplate;
}

async function publishedTargetBytesCrossCheck(prepared, published) {
  invariant(prepared.length === published.length, "Jahresrelease-Veroeffentlichung ist fuer den finalen Byte-Cross-Check unvollstaendig.");
  const byTemplate = new Map();
  for (const [index, contract] of prepared.entries()) {
    const bytes = await readOwnedBytesForCrossCheck(published[index]);
    invariant(bytes.equals(Buffer.from(contract.content, "utf8")),
      `Jahresrelease-Zielbytes driften nach der atomaren Veroeffentlichung: ${contract.template}`);
    byTemplate.set(contract.template, bytes);
  }
  return byTemplate;
}

/**
 * Erstellt den vollständigen eingecheckten JSON-Vertragssatz eines neuen
 * Jahres-Patchreleases. Die Quellvertraege bleiben bytegleich unveraendert;
 * jedes Ziel wird ausschließlich create-new angelegt.
 */
export async function createAnnualPatchRelease({
  repositoryRoot,
  sourcePatch,
  targetPatch,
  files = ANNUAL_PATCH_CONTRACT_FILES,
  textFiles = ANNUAL_PATCH_TEXT_FILES,
  openCreateNewFile = open,
  publishLink = link,
  hooks = {},
}) {
  const root = resolve(repositoryRoot);
  const source = parsedPatch(sourcePatch, "Quellpatch");
  const target = parsedPatch(targetPatch, "Zielpatch");
  invariant(source.year === target.year && target.patch === source.patch + 1, "Zielpatch muss der direkte naechste Patch desselben Fahrplanjahres sein.");
  invariant(Array.isArray(files) && files.length > 0 && new Set(files).size === files.length, "Jahresvertragsliste muss eindeutig und nicht leer sein.");
  invariant(Array.isArray(textFiles) && new Set(textFiles).size === textFiles.length, "Jahres-Textvertragsliste muss eindeutig sein.");
  invariant(typeof openCreateNewFile === "function", "Create-new-Dateioeffner fehlt.");
  invariant(typeof publishLink === "function", "Atomare create-new-Verlinkung fehlt.");
  for (const template of [...files, ...textFiles]) assertNoMigrationTemplateAlias(root, template, target.value);

  const contracts = [
    ...files.map((template) => Object.freeze({ format: "json", template })),
    ...textFiles.map((template) => Object.freeze({ format: "text", template })),
  ].map(({ format, template }) => Object.freeze({
    format,
    source: GENERATED_TARGET_ONLY_TEMPLATES.has(template)
      ? null
      : pathInside(root, contractPath(template, source.value), "Jahresvertragsquelle"),
    target: pathInside(root, contractPath(template, target.value), "Jahresvertragsziel"),
    template,
  }));
  invariant(new Set(contracts.map(({ target: path }) => path)).size === contracts.length, "Jahresvertragsziele sind nicht eindeutig.");
  const requestedOperationalDependencyTargets = new Set(
    contracts
      .map(({ template }) => template)
      .filter((template) => OPERATIONAL_DEPENDENCY_TARGET_TEMPLATES.includes(template)),
  );
  invariant(
    requestedOperationalDependencyTargets.size === 0
      || requestedOperationalDependencyTargets.size === OPERATIONAL_DEPENDENCY_TARGET_TEMPLATES.length,
    "Operational-v2-Execution-Pins, Direct-System-Launch und Release-Config muessen als unteilbare Jahresrelease-Closure gemeinsam erzeugt werden.",
  );
  invariant(
    !contracts.some(({ template }) => template === OPERATIONAL_VALIDATOR_REBUILD_TEMPLATE)
      || requestedOperationalDependencyTargets.size === OPERATIONAL_DEPENDENCY_TARGET_TEMPLATES.length,
    "Operational-Validator-Rebuild-v3 muss gemeinsam mit der unteilbaren Operational-v2-Dependency-Closure erzeugt werden.",
  );
  for (const contract of contracts) {
    if (contract.source !== null) await assertCanonicalSourceResolution(root, contract, source.value);
  }

  const operationalDependencySnapshot = requestedOperationalDependencyTargets.size > 0
    ? await createOperationalDependencyByteSnapshot(target.value, root)
    : undefined;
  if (operationalDependencySnapshot !== undefined) {
    await invokeAnnualPatchHook(hooks, "afterOperationalDependencySnapshot", {
      dependencyProofs: structuredClone(operationalDependencySnapshot.dependencyProofs),
      targetPatch: target.value,
    });
  }

  const prepared = [];
  for (const contract of contracts) {
    await absent(contract.target, `Jahresvertragsziel ${contract.template}`);
    const preparedContract = Object.freeze({
      ...contract,
      content: await migrateTargetContract(
        contract.source === null
          ? undefined
          : await readContract(contract.source, source.value, target.value, contract.format),
        contract.template,
        source.value,
        target.value,
        operationalDependencySnapshot,
      ),
    });
    prepared.push(preparedContract);
    await invokeAnnualPatchHook(hooks, "afterPreparedContract", {
      targetPatch: target.value,
      template: contract.template,
    });
  }

  const claimPath = pathInside(root, `tools/region-import/germany/.annual-patch-release-${target.value}.claim`, "Jahresrelease-Claim");
  const stagingRoot = pathInside(
    root,
    `tools/region-import/germany/.annual-patch-release-${target.value}.${process.pid}-${randomUUID()}`,
    "Jahresrelease-Staging",
  );
  await absent(claimPath, "Jahresrelease-Claim");
  await mkdir(dirname(claimPath), { recursive: true });
  let claim;
  let stagingCreated = false;
  let operationError;
  const staged = [];
  const createdTargets = [];
  try {
    claim = await createOwnedFile(claimPath, 0o600, openCreateNewFile);
    await writeAndSyncOwnedFile(claim, `${source.value}->${target.value}\n`);
    await mkdir(stagingRoot, { mode: 0o700 });
    stagingCreated = true;
    for (const [index, contract] of prepared.entries()) {
      const stagingPath = pathInside(
        stagingRoot,
        `${String(index).padStart(4, "0")}.stage`,
        "Jahresvertrags-Stagingdatei",
      );
      const owned = await createOwnedFile(stagingPath, 0o644, openCreateNewFile);
      staged.push(owned);
      await writeAndSyncOwnedFile(owned, contract.content);
    }
    await invokeAnnualPatchHook(hooks, "beforePreparedTargetCrossCheck", {
      targetPatch: target.value,
      templates: prepared.map(({ template }) => template),
    });
    const stagedBytesByTemplate = await stagedTargetBytesCrossCheck(prepared, staged);
    if (operationalDependencySnapshot !== undefined) {
      operationalPreparedTargetCrossCheck(stagedBytesByTemplate, operationalDependencySnapshot, target.value);
      await verifyOperationalDependencyByteSnapshot(root, operationalDependencySnapshot);
    }
    for (const [index, contract] of prepared.entries()) {
      await absent(contract.target, `Jahresvertragsziel ${contract.template}`);
      await mkdir(dirname(contract.target), { recursive: true });
      await publishLink(staged[index].path, contract.target);
      const targetOwned = {
        closed: true,
        handle: undefined,
        identity: staged[index].identity,
        path: contract.target,
      };
      createdTargets.push(targetOwned);
      const targetMetadata = await lstat(contract.target, { bigint: true });
      invariant(
        targetMetadata.isFile() && sameOwnedIdentity(targetMetadata, targetOwned.identity),
        `Atomare create-new-Veroeffentlichung besitzt nicht die gepruefte Stagingidentitaet: ${contract.target}`,
      );
      const publishedBytes = await readOwnedBytesForCrossCheck(targetOwned);
      invariant(
        publishedBytes.equals(Buffer.from(contract.content, "utf8")),
        `Atomare create-new-Veroeffentlichung besitzt nicht die vorbereiteten Zielbytes: ${contract.target}`,
      );
    }
    await invokeAnnualPatchHook(hooks, "afterPublishedTargets", {
      targetPatch: target.value,
      templates: prepared.map(({ template }) => template),
    });
    if (operationalDependencySnapshot !== undefined) {
      await verifyOperationalDependencyByteSnapshot(root, operationalDependencySnapshot);
    }
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = await cleanupOwnedFiles(staged, hooks);
  if (stagingCreated) {
    try {
      await rmdir(stagingRoot);
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupErrors.push(error);
    }
  }
  if (claim !== undefined) cleanupErrors.push(...await cleanupOwnedFiles([claim], hooks));
  if (operationError === undefined && cleanupErrors.length === 0) {
    try {
      const publishedBytesByTemplate = await publishedTargetBytesCrossCheck(prepared, createdTargets);
      if (operationalDependencySnapshot !== undefined) {
        operationalPreparedTargetCrossCheck(publishedBytesByTemplate, operationalDependencySnapshot, target.value);
        await verifyOperationalDependencyByteSnapshot(root, operationalDependencySnapshot);
      }
    } catch (error) {
      operationError = error;
    }
  }
  const preliminaryError = combinedOperationError(operationError, cleanupErrors);
  if (preliminaryError !== undefined) {
    const rollbackErrors = await cleanupOwnedFiles(createdTargets, hooks);
    throw combinedOperationError(preliminaryError, rollbackErrors);
  }

  return Object.freeze({
    files: Object.freeze(prepared.map(({ target: path }) => relative(root, path).replaceAll("\\", "/"))),
    sourcePatch: source.value,
    targetPatch: target.value,
  });
}

async function main(argv) {
  if (argv[0] === "regenerate-operational-closure") {
    const [, targetPatch, repositoryRoot = ".", ...extra] = argv;
    invariant(targetPatch && extra.length === 0,
      "Aufruf: create-annual-patch-release.mjs regenerate-operational-closure TARGET_PATCH [REPOSITORY_ROOT]");
    const root = resolve(repositoryRoot);
    const files = await createCurrentOperationalDependencyContractClosure({ repositoryRoot: root, targetPatch });
    for (const [file, content] of Object.entries(files)) {
      await writeFile(pathInside(root, file, `Operational-v2-Current-Closure ${file}`), content, "utf8");
    }
    process.stdout.write(`${JSON.stringify({ files: Object.keys(files), targetPatch })}\n`);
    return;
  }
  const [sourcePatch, targetPatch, repositoryRoot = "."] = argv;
  invariant(sourcePatch && targetPatch, "Aufruf: create-annual-patch-release.mjs SOURCE_PATCH TARGET_PATCH [REPOSITORY_ROOT]");
  const result = await createAnnualPatchRelease({ repositoryRoot, sourcePatch, targetPatch });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
