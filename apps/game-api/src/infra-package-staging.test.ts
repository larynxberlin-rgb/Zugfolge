import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
  type KeyObject,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { InfraUpdateService, type InfraActivationSafety } from "@zugfolge/alpha";
import { MIGRATIONS_FOLDER, alphaWorldProfiles, infraReleaseChanges, worlds } from "@zugfolge/db";
import * as databaseSchema from "@zugfolge/db/schema";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalMapPackageVerifier,
  GERMANY_2026_5_OPERATIONAL_REPIN,
  germanyOperationalDeliveryV2Generation,
  InfraPackageStaging,
  InfraPackageStagingError,
  infraUploadSignature,
  validateInfraPackageOperationalAuthority,
  validateInfraPackageOperationalProvenance,
  verifyInfraUploadSignature,
  type InfraOperationalV2NativeVerifier,
  type InfraPackageVerifier,
} from "./infra-package-staging.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const OPERATIONAL_STATE_HASH = "d".repeat(64);

it("laesst nur die drei historischen Deutschland-Stagingvertraege und den exakt aktuellen 2026.5-Vertrag zu", () => {
  for (const version of ["2026.1", "2026.3", "2026.4"]) {
    expect(germanyOperationalDeliveryV2Generation(version)).toBe("legacy-v1");
  }
  expect(germanyOperationalDeliveryV2Generation("2026.5")).toBe("integrated-provenance-v2");
  for (const version of ["2026.2", "2026.6", "2027.1", "2026.5-near-miss"]) {
    expect(() => germanyOperationalDeliveryV2Generation(version)).toThrow(/nicht als Deutschland-Delivery-v2-Version freigegeben/u);
  }
});

it("leitet den Game-Repin bytegenau aus der eingecheckten 2026.5-Execution-Pins-Datei ab", async () => {
  const bytes = await readFile(new URL(
    "../../../tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
    import.meta.url,
  ));
  const pins = JSON.parse(bytes.toString("utf8"));
  expect(GERMANY_2026_5_OPERATIONAL_REPIN).toEqual({
    executionPins: {
      file: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
      bytes: bytes.length,
      sha256: sha256(bytes),
      schema: pins.schema,
    },
    runtime: pins.runner.runtime,
    anchorHelper: pins.runner.anchorHelper,
    bundle: pins.runner.bundle,
    entrypoint: pins.runner.entrypoint,
    validator: {
      buildCommit: pins.validator.buildCommit,
      preserved: {
        file: pins.validator.file,
        bytes: pins.validator.bytes,
        sha256: pins.validator.sha256,
      },
      executedMode: "windows-exclusive-handle-launch-v1",
    },
    launcher: {
      file: "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1",
      mode: pins.runner.launcher.mode,
      sourceBytes: pins.runner.launcher.sourceBytes,
      sourceSha256: pins.runner.launcher.sourceSha256,
    },
    importClosure: pins.runner.importClosure,
  });
});

function integratedOperationalProvenance() {
  const repin = GERMANY_2026_5_OPERATIONAL_REPIN;
  return {
    schema: "zugfolge-germany-operational-v2-provenance/v1",
    producerKind: "integrated-runner-v1",
    releaseEvidenceEligible: true,
    productionActivationEligible: true,
    executionPins: { ...repin.executionPins },
    executionProof: {
      schema: "zugfolge-germany-operational-v2-execution-proof/v1",
      executionPinsSha256: repin.executionPins.sha256,
      runner: {
        anchorHelper: { ...repin.anchorHelper },
        bundle: { ...repin.bundle },
        entrypoint: { ...repin.entrypoint },
        importClosure: repin.importClosure.map((entry) => ({ ...entry })),
        invocation: {
          mode: "system-launcher-held-bundle-stdin-v1",
          nodeArguments: ["--input-type=module", "-"],
          nodeOptions: null,
        },
        launcher: { mode: repin.launcher.mode, sourceBytes: repin.launcher.sourceBytes, sourceSha256: repin.launcher.sourceSha256 },
        runtime: { ...repin.runtime },
      },
      validator: {
        buildCommit: repin.validator.buildCommit,
        preserved: { ...repin.validator.preserved },
        executed: { mode: repin.validator.executedMode, bytes: repin.validator.preserved.bytes, sha256: repin.validator.preserved.sha256 },
      },
      rebuild: {
        specification: { file: "tools/region-import/germany/operational-validator-rebuild.annual-2026.5.json", bytes: 201, sha256: "7".repeat(64) },
        evidence: { file: "var/derived/germany-2026.5/toolchain/rebuild-evidence.json", bytes: 202, sha256: "8".repeat(64), schema: "zugfolge-operational-validator-rebuild-evidence/v2" },
        sourceCommit: repin.validator.buildCommit,
      },
      invocation: {
        command: "derive-germany-operational-v2",
        argumentPrefix: [],
        argumentFiles: [],
        arguments: ["derive-germany-operational-v2", "spec.json", "source", "candidate.json", "report.json"],
      },
      stdout: { bytes: 401, sha256: HASH_A, recordCount: 1, structuredReceiptSha256: HASH_B },
      exit: { code: 0, signal: null },
    },
  };
}

function integratedOperationalAuthority() {
  const sourceCommit = "c".repeat(40);
  const rebuildBundle = {
    file: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json",
    bytes: 501,
    sha256: "1".repeat(64),
  };
  const plan = { file: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json", bytes: 502, sha256: "2".repeat(64) };
  const planCompletion = { file: `${plan.file}.zugfolge-complete.json`, bytes: 503, sha256: "3".repeat(64) };
  const startEvidence = { file: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json", bytes: 504, sha256: "4".repeat(64) };
  const startEvidenceCompletion = { file: `${startEvidence.file}.zugfolge-complete.json`, bytes: 505, sha256: "5".repeat(64) };
  const outerExecutionReceipt = { file: "var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json", bytes: 506, sha256: "6".repeat(64) };
  const outerExecutionCompletion = { file: `${outerExecutionReceipt.file}.zugfolge-complete.json`, bytes: 507, sha256: "7".repeat(64) };
  const predicate = {
    schema: "zugfolge-operational-v2-execution-authority/v1",
    releaseId: "infra-deutschland-2026.5",
    origin: "local-held-runner",
    verificationScope: "operator-approved-hash-binding-not-source-reexecution-v1",
    protectedEnvironment: "operational-release-approval",
    requiredPhases: ["materialize-annual-plan-evidence-v1", "execute-annual-operational-v2-v1", "derive-and-capture-v1"],
    executionJob: { mode: "windows-kill-on-job-close-root-exit-bounded-io-v1", timeoutMilliseconds: 21_600_000 },
    source: { repository: "larynxberlin-rgb/Zugfolge", ref: "refs/heads/main", commit: sourceCommit },
    planAuthority: {
      artifact: { digest: `sha256:${"8".repeat(64)}`, id: 123, workflowRunId: 456 },
      bundle: { ...rebuildBundle },
      plan,
      planCompletion,
      startEvidence,
      startEvidenceCompletion,
    },
    outerExecutionReceipt,
    outerExecutionCompletion,
  };
  return {
    schema: "zugfolge-map-build-operational-authority/v1",
    rebuild: {
      bundle: rebuildBundle,
      denySelfHostedRunners: true,
      predicateType: "https://slsa.dev/provenance/v1",
      repository: "larynxberlin-rgb/Zugfolge",
      signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml",
      sourceDigest: sourceCommit,
      sourceRef: "refs/heads/main",
      subjects: [plan, planCompletion, startEvidence, startEvidenceCompletion]
        .sort((left, right) => left.file.localeCompare(right.file, "en")),
    },
    execution: {
      bundle: {
        file: "var/derived/germany-2026.5/toolchain/zugfolge-operational-v2-execution-authority.sigstore.json",
        bytes: 508,
        sha256: "9".repeat(64),
      },
      denySelfHostedRunners: true,
      predicateType: "https://zugfolge.de/attestations/operational-v2-execution-authority/v1",
      repository: "larynxberlin-rgb/Zugfolge",
      signerWorkflow: "larynxberlin-rgb/Zugfolge/.github/workflows/operational-v2-execution-authority.yml",
      sourceDigest: sourceCommit,
      sourceRef: "refs/heads/main",
      subjects: [outerExecutionReceipt, outerExecutionCompletion]
        .sort((left, right) => left.file.localeCompare(right.file, "en")),
      predicate,
      predicateSha256: sha256(JSON.stringify(sorted(predicate))),
    },
    trustedRoot: {
      id: "operational-attestation-trusted-root",
      kind: "derived-input",
      version: "infra-deutschland-2026.5",
      file: "var/derived/germany-2026.5/toolchain/github-attestation-trusted-root.jsonl",
      bytes: 34_634,
      sha256: "65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c",
    },
    verifier: {
      id: "operational-attestation-verifier",
      kind: "derived-input",
      version: "infra-deutschland-2026.5",
      file: "var/derived/germany-2026.5/toolchain/gh-2.94.0-windows-amd64.exe",
      bytes: 40_998_712,
      sha256: "91ed1eff1819a96b34bc2ca3adc01822c807ae1bb883c01ad9fdf335bf242b38",
    },
  };
}

it("weist forensische oder prooflose Operational-v2-Provenienz an der Game-Grenze fail-closed ab", () => {
  const executionPins = { ...GERMANY_2026_5_OPERATIONAL_REPIN.executionPins };
  expect(() => validateInfraPackageOperationalProvenance({
    schema: "zugfolge-germany-operational-v2-provenance/v1",
    producerKind: "forensic-stdin-v1",
    releaseEvidenceEligible: false,
    productionActivationEligible: false,
    executionPins,
    executionProof: null,
  })).toThrow(/nur integrierte/u);
  expect(() => validateInfraPackageOperationalProvenance({
    schema: "zugfolge-germany-operational-v2-provenance/v1",
    producerKind: "integrated-runner-v1",
    releaseEvidenceEligible: true,
    productionActivationEligible: true,
    executionPins,
    executionProof: null,
  })).toThrow(/executionProof muss ein Objekt/u);
});

it("bindet die aktuelle Operational-v2-Runner-Provenienz exakt und verwirft Legacy- oder driftende Shapes", () => {
  const valid = integratedOperationalProvenance();
  expect(validateInfraPackageOperationalProvenance(valid)).toMatchObject({ validatorSha256: GERMANY_2026_5_OPERATIONAL_REPIN.validator.preserved.sha256 });

  type Provenance = ReturnType<typeof integratedOperationalProvenance>;
  const cases: readonly [string, (value: Provenance) => void][] = [
    ["fehlende Execution-Pins", (value) => { delete (value as Partial<Provenance>).executionPins; }],
    ["falsche Execution-Pins-Bytezahl", (value) => { value.executionPins.bytes += 1; }],
    ["formal gueltiger falscher Execution-Pins-SHA", (value) => {
      value.executionPins.sha256 = "f".repeat(64);
      value.executionProof.executionPinsSha256 = value.executionPins.sha256;
    }],
    ["fehlendes Bundle", (value) => { delete (value.executionProof.runner as Partial<typeof value.executionProof.runner>).bundle; }],
    ["formal gueltiger falscher Bundle-SHA", (value) => { value.executionProof.runner.bundle.sha256 = "f".repeat(64); }],
    ["formal gueltiger falscher Entrypoint-SHA", (value) => { value.executionProof.runner.entrypoint.sha256 = "f".repeat(64); }],
    ["fehlender Windows-Anchor-Helper", (value) => { delete (value.executionProof.runner as Partial<typeof value.executionProof.runner>).anchorHelper; }],
    ["driftender Windows-Anchor-Helper", (value) => { value.executionProof.runner.anchorHelper.sha256 = "e".repeat(64); }],
    ["Windows-Anchor-Helper fehlt in Importclosure", (value) => {
      value.executionProof.runner.importClosure = value.executionProof.runner.importClosure
        .filter(({ file }) => file !== GERMANY_2026_5_OPERATIONAL_REPIN.anchorHelper.file);
    }],
    ["Legacy-Aufruf", (value) => {
      value.executionProof.runner.invocation = { execArgv: [], nodeOptions: null } as unknown as typeof value.executionProof.runner.invocation;
    }],
    ["falsche Node-Argumente", (value) => { value.executionProof.runner.invocation.nodeArguments = ["--input-type=module", "runner.mjs"]; }],
    ["falscher Invocation-Modus", (value) => { value.executionProof.runner.invocation.mode = "process-execfile-runner-v1"; }],
    ["falscher Launcher-Modus", (value) => { value.executionProof.runner.launcher.mode = "windows-exclusive-handle-launch-v1"; }],
    ["fehlende Launcher-Quelldatei", (value) => {
      value.executionProof.runner.importClosure = value.executionProof.runner.importClosure.filter(({ file }) => !file.endsWith("system-launcher.windows.ps1"));
    }],
    ["falsche Launcher-Bytezahl", (value) => { value.executionProof.runner.launcher.sourceBytes += 1; }],
    ["formal gueltiger falscher Launcher-Quellhash", (value) => { value.executionProof.runner.launcher.sourceSha256 = "f".repeat(64); }],
    ["nicht bytegleiche Launcher-Closure", (value) => {
      const source = value.executionProof.runner.importClosure.find(({ file }) => file.endsWith("system-launcher.windows.ps1"));
      if (source !== undefined) source.bytes += 1;
    }],
    ["doppelter Launcher in der Closure", (value) => {
      const index = value.executionProof.runner.importClosure.findIndex(({ file }) => file.endsWith("system-launcher.windows.ps1"));
      if (index >= 0) value.executionProof.runner.importClosure.splice(index, 0, { ...value.executionProof.runner.importClosure[index]! });
    }],
    ["unsortierte Importclosure", (value) => {
      [value.executionProof.runner.importClosure[0], value.executionProof.runner.importClosure[1]] = [
        value.executionProof.runner.importClosure[1]!, value.executionProof.runner.importClosure[0]!,
      ];
    }],
    ["ungueltiger Launcher-Quellhash", (value) => { value.executionProof.runner.launcher.sourceSha256 = "not-a-sha256"; }],
    ["nichtstring Launcher-Quellhash", (value) => { value.executionProof.runner.launcher.sourceSha256 = [HASH_A] as unknown as string; }],
    ["falsche Runtime", (value) => { value.executionProof.runner.runtime.id = "nodejs-path-only-v1"; }],
    ["falsche Plattformkopplung", (value) => { value.executionProof.runner.runtime.platform = "linux"; }],
    ["nichtstring Runtime-Plattform", (value) => { value.executionProof.runner.runtime.platform = ["win32"] as unknown as string; }],
    ["falsche Runtime-Bytezahl", (value) => { value.executionProof.runner.runtime.bytes += 1; }],
    ["formal gueltiger falscher Runtime-SHA", (value) => { value.executionProof.runner.runtime.sha256 = "f".repeat(64); }],
    ["falscher Validator-Build-Commit", (value) => {
      value.executionProof.validator.buildCommit = "f".repeat(40);
      value.executionProof.rebuild.sourceCommit = value.executionProof.validator.buildCommit;
    }],
    ["falsche preserved Validator-Bytezahl", (value) => {
      value.executionProof.validator.preserved.bytes += 1;
      value.executionProof.validator.executed.bytes = value.executionProof.validator.preserved.bytes;
    }],
    ["formal gueltiger falscher preserved Validator-SHA", (value) => {
      value.executionProof.validator.preserved.sha256 = "f".repeat(64);
      value.executionProof.validator.executed.sha256 = value.executionProof.validator.preserved.sha256;
    }],
  ];
  for (const [label, mutate] of cases) {
    const drifted = structuredClone(valid);
    mutate(drifted);
    expect(() => validateInfraPackageOperationalProvenance(drifted), label).toThrow();
  }
});

it("bindet Phase 1, Phase 2 und beide Outer-Belege in einer kanonischen Operational-v2-Build-Authority", () => {
  const authority = integratedOperationalAuthority();
  const proof = validateInfraPackageOperationalAuthority(authority);
  expect(proof).toEqual({
    sha256: sha256(JSON.stringify(sorted(authority))),
    rebuildAttestationSha256: authority.rebuild.bundle.sha256,
    executionAuthorityAttestationSha256: authority.execution.bundle.sha256,
    outerExecutionReceiptSha256: authority.execution.predicate.outerExecutionReceipt.sha256,
    outerExecutionCompletionSha256: authority.execution.predicate.outerExecutionCompletion.sha256,
    sourceCommit: authority.execution.sourceDigest,
  });
  const drifts: readonly [string, (value: ReturnType<typeof integratedOperationalAuthority>) => void][] = [
    ["fehlendes Phase-1-Subject", (value) => { value.rebuild.subjects = value.rebuild.subjects.slice(1); }],
    ["getauschtes Outer-Receipt", (value) => {
      value.execution.predicate.outerExecutionReceipt = { ...value.execution.predicate.outerExecutionCompletion };
      value.execution.predicateSha256 = sha256(JSON.stringify(sorted(value.execution.predicate)));
    }],
    ["driftender protected-main-Commit", (value) => { value.execution.sourceDigest = "d".repeat(40); }],
    ["fremder Execution-Bundlepfad", (value) => { value.execution.bundle.file = "var/derived/germany-2026.5/toolchain/foreign.sigstore.json"; }],
    ["zusaetzliches Feld", (value) => { (value.execution.predicate as Record<string, unknown>)["unexpected"] = true; }],
  ];
  for (const [label, mutate] of drifts) {
    const drifted = structuredClone(authority);
    mutate(drifted);
    expect(() => validateInfraPackageOperationalAuthority(drifted), label).toThrow();
  }
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadlineMs) throw new Error("Testbedingung wurde nicht rechtzeitig erreicht.");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonical(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(sorted(value), null, 2)}\n`, "utf8");
}

function compact(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

interface FixturePart {
  readonly id: string;
  readonly path: string;
  readonly bytes: Buffer;
}

interface DeliveryV2ProducerGolden {
  readonly schema: "zugfolge-delivery-v2-producer-golden/v1";
  readonly release: {
    readonly schema: "zugfolge-map-delivery-release/v2";
    readonly releaseId: string;
    readonly releaseHash: null;
    readonly signature: null;
  };
  readonly sources: { readonly schema: "zugfolge-map-delivery-sources/v2" };
  readonly manifestBase64: string;
  readonly parts: readonly {
    readonly id: string;
    readonly path: string;
    readonly contentBase64: string;
  }[];
}

async function deliveryV2ProducerGoldenFixture(): Promise<{
  readonly golden: DeliveryV2ProducerGolden;
  readonly fixture: { readonly manifest: Buffer; readonly parts: readonly FixturePart[] };
}> {
  const golden = JSON.parse(await readFile(
    new URL("../../../odoo/addons/zugfolge_admin/tests/fixtures/delivery_v2_producer_golden.json", import.meta.url),
    "utf8",
  )) as DeliveryV2ProducerGolden;
  expect(golden.schema).toBe("zugfolge-delivery-v2-producer-golden/v1");
  return {
    golden,
    fixture: {
      manifest: Buffer.from(golden.manifestBase64, "base64"),
      parts: golden.parts.map((part) => ({
        id: part.id,
        path: part.path,
        bytes: Buffer.from(part.contentBase64, "base64"),
      })),
    },
  };
}

interface PackageFixtureOptions {
  readonly packageVersion?: string;
  readonly operationalProvenance?: ReturnType<typeof integratedOperationalProvenance>;
  readonly operationalAuthority?: ReturnType<typeof integratedOperationalAuthority>;
  readonly visibleMapClassCFeatures?: number;
  readonly operationalClassCArtifacts?: number;
  readonly unresolvedRequired?: number;
  readonly closureReceiptVerified?: boolean;
  readonly mapClassCReclassified?: boolean;
  readonly infraReleaseHash?: string | null;
  readonly mapReleaseHash?: string | null;
  readonly assetInventoryPlanSha256?: string | null;
  readonly assetTreeSha256?: string;
  readonly deliveryOperationalStateHash?: string;
  readonly deliveryMovementRouteTemplatesBytes?: Buffer;
  readonly deliveryTransferDemandsBytes?: Buffer;
  readonly qualityMovementRouteTemplatesSha256?: string;
  readonly qualityTransferDemandsSha256?: string;
  readonly qualityJourneyChainCount?: number;
  readonly operationalInfraReleaseId?: string;
  readonly omitUnsignedReleaseHash?: boolean;
  readonly unsignedReleaseHash?: string | null;
  readonly unsignedSignatureReason?: string | null;
  readonly unsignedSignatureExtraField?: boolean;
  readonly compactReleaseBytes?: boolean;
}

interface FixtureFile {
  readonly id: string;
  readonly kind: string;
  readonly installPath: string;
  readonly bytes: Buffer;
  readonly infraReleaseId?: string;
  readonly stateHash?: string;
}

function assetNotices(glyphBytes: Buffer, spriteBytes: Buffer) {
  const upstreamCommit = "1".repeat(40);
  const tangramsCommit = "2".repeat(40);
  const glyphCopyright = "Copyright 2012 Google Inc.";
  const glyphNotice = `${glyphCopyright}\nSIL OPEN FONT LICENSE Version 1.1\nFixture license terms.\n`;
  const spriteCopyright = "Copyright 2016 Tangrams contributors";
  const spriteNotice = `${spriteCopyright}\nThe MIT License (MIT)\nFixture license terms.\n`;
  const tree = (installDirectory: string, path: string, bytes: Buffer) => ({
    installDirectory,
    files: 1,
    bytes: bytes.length,
    sha256: sha256(`${path}\0${bytes.length}\0${sha256(bytes)}\n`),
  });
  return {
    schema: "zugfolge-map-asset-notices/v2",
    assets: [
      {
        id: "noto-glyphs",
        rightsSourceId: "noto-glyphs",
        kind: "glyph",
        license: "OFL-1.1",
        copyright: glyphCopyright,
        modifications: "Subsetted and converted into deterministic glyph ranges.",
        source: { repository: "https://github.com/protomaps/basemaps-assets", commit: upstreamCommit, path: "fonts" },
        derivedFrom: null,
        notice: {
          url: `https://raw.githubusercontent.com/protomaps/basemaps-assets/${upstreamCommit}/fonts/OFL.txt`,
          bytes: Buffer.byteLength(glyphNotice),
          sha256: sha256(glyphNotice),
          text: glyphNotice,
        },
        tree: tree("assets/fonts", "font.pbf", glyphBytes),
      },
      {
        id: "protomaps-sprites",
        rightsSourceId: "protomaps-sprites",
        kind: "sprite",
        license: "MIT",
        copyright: spriteCopyright,
        modifications: "Packed and recolored for the deterministic dark map style.",
        source: { repository: "https://github.com/protomaps/basemaps-assets", commit: upstreamCommit, path: "sprites" },
        derivedFrom: { repository: "https://github.com/tangrams/icons", commit: tangramsCommit, license: "MIT" },
        notice: {
          url: `https://raw.githubusercontent.com/tangrams/icons/${tangramsCommit}/LICENSE.md`,
          bytes: Buffer.byteLength(spriteNotice),
          sha256: sha256(spriteNotice),
          text: spriteNotice,
        },
        tree: tree("assets/sprites", "dark.png", spriteBytes),
      },
    ],
  };
}

function packageFixture(
  rawDataPolicyField: "nonPublicSourceRawDataShipped" | "internalStationPlanRawDataShipped" = "nonPublicSourceRawDataShipped",
  signing?: { readonly keyId: string; readonly privateKey: KeyObject },
  options: PackageFixtureOptions = {},
): { readonly manifest: Buffer; readonly parts: readonly FixturePart[] } {
  const packageVersion = options.packageVersion ?? "2026.1";
  const releaseId = `infra-deutschland-${packageVersion}`;
  const mapReleaseId = `karte-deutschland-${packageVersion}-v2`;
  const visibleMapClassC = options.visibleMapClassCFeatures ?? 2;
  const operationalClassC = options.operationalClassCArtifacts ?? 0;
  const operationalBytes = Buffer.from(`${JSON.stringify({ id: releaseId, schema: "zugfolge-operational-infrastructure/v2" })}\n`);
  const movementRouteTemplatesBytes = Buffer.from(`${JSON.stringify({ infraReleaseId: releaseId, schema: "movement-route-templates-v2" })}\n`);
  const transferDemandsBytes = Buffer.from(`${JSON.stringify({ infraReleaseId: releaseId, schema: "zugfolge-timetable-transfer-demands/v2" })}\n`);
  const glyphBytes = Buffer.from("glyph");
  const spriteBytes = Buffer.from("sprite");
  const notices = assetNotices(glyphBytes, spriteBytes);
  if (options.assetTreeSha256 !== undefined) notices.assets[0]!.tree.sha256 = options.assetTreeSha256;
  const quality = compact({
    schema: "zugfolge-operational-infrastructure-quality-report/v1",
    releaseId,
    timetableYear: 2026,
    scopeId: "deutschland-ebo-operational-v2",
    deterministic: true,
    separation: {
      mapEvidencePurpose: "visible-map-quality-evidence",
      operationalEvidencePurpose: "closed-operational-v2-model",
      mapClassCReclassified: options.mapClassCReclassified ?? false,
      mapClassCBlocksOperationalQualityGate: false,
      mapObjectsRemoved: false,
    },
    mapEvidence: {
      schema: "zugfolge-static-map-quality/v2",
      mapReleaseId,
      infrastructureCorpusId: releaseId,
      bytes: 4_321,
      sha256: HASH_A,
      sourceReport: {
        schema: "zugfolge-final-infrastructure-quality-report/v1",
        bytes: 9_876,
        sha256: HASH_B,
        shipped: false,
      },
      visibleLayers: 10,
      visibleFeatures: 42,
      qualityClassFeatureCount: { A: 12, B: 30 - visibleMapClassC, C: visibleMapClassC },
      trackLengthMm: 3_000,
      trackQualityClassLengthMm: { A: 1_000, B: 1_900, C: 100 },
    },
    operationalModel: {
      policyId: "synthetic-operational-b/v2",
      policySha256: HASH_A,
      closureReceiptSha256: HASH_B,
      qualityClass: "B",
      provenance: "derived",
      realGeometry: true,
      simulatedOperationalAssignment: true,
      realInterlockingFactsClaimed: false,
      syntheticOperationalDetailsShipped: true,
      objectLevelProvenanceShipped: false,
      observedAndSyntheticObjectsShareRuntimeCollections: true,
      movementRouteTemplates: {
        bytes: movementRouteTemplatesBytes.length,
        sha256: options.qualityMovementRouteTemplatesSha256 ?? sha256(movementRouteTemplatesBytes),
        stateHash: HASH_B,
        operationalStateHash: OPERATIONAL_STATE_HASH,
        timetableTransferSetSha256: HASH_A,
      },
      timetableRouteEvidence: {
        reportSchema: "zugfolge-germany-timetable-route-report/v4",
        policyId: "synthetic-operational-b/v2",
        derivationRule: "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2",
        selectionRule: "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2",
        reportBytes: 1_234,
        reportSha256: HASH_A,
        routesBytes: 5_678,
        routesSha256: HASH_B,
        gtfsSnapshotBytes: 9_012,
        gtfsSnapshotSha256: HASH_C,
        transferDemandsSchema: "zugfolge-timetable-transfer-demands/v2",
        transferDemandsBytes: transferDemandsBytes.length,
        transferDemandsSha256: options.qualityTransferDemandsSha256 ?? sha256(transferDemandsBytes),
        snapshotHash: HASH_A,
        archive: "gtfs-free.zip",
        archiveSha256: HASH_B,
        sourceLicense: "CC-BY-4.0",
        sourceLicenseAsPublished: "CC BY 4.0",
        selectedSegmentCount: 4,
        completeRouteCount: 4,
        routeRecordCount: 4,
        sameStopTransitionCount: 1,
        routeSetSha256: HASH_B,
        dailyCirculationPlanSha256: HASH_C,
        transferSetSha256: HASH_A,
        transferDemandsProduced: true,
        dailyCirculation: {
          lotCount: 2,
          journeyChainCount: options.qualityJourneyChainCount ?? 4,
          circulationCount: 2,
          rolloverAssignmentCount: 2,
          plannedTransitionCount: 4,
          turnaroundDemandCount: 3,
          transferDemandCount: 1,
          transferLotCount: 1,
        },
        transferRouteCount: 1,
        transferRouteLegCount: 3,
        transferRouteLengthMm: 12_345,
        realGeometry: true,
        simulatedOperationalAssignment: true,
        realInterlockingFactsClaimed: false,
        externalOperationalNetworkProvenance: false,
      },
      operationalArtifact: {
        bytes: operationalBytes.length,
        sha256: sha256(operationalBytes),
        stateHash: OPERATIONAL_STATE_HASH,
      },
      coverage: {
        blockResources: 3,
        directedEdges: 2,
        edgeGeometries: 2,
        interlockingRoutes: 2,
        platformIntervals: 1,
        regionBoundaries: 1,
        routeVersions: 4,
        rzueLayouts: 1,
        signals: 2,
        switches: 1,
      },
    },
    summary: {
      operationalQualityClassArtifactCount: { A: 0, B: 1 - operationalClassC, C: operationalClassC },
      unresolvedRequired: options.unresolvedRequired ?? 0,
      visibleMapClassCFeatureCount: visibleMapClassC,
    },
    qualityGate: {
      closureReceiptVerified: options.closureReceiptVerified ?? true,
      nativeOperationalValidationVerified: true,
      operationalClassCZero: true,
      ordinaryAssumptionsPromoted: false,
      mapClassCReclassified: options.mapClassCReclassified ?? false,
      operationalQualityEligible: true,
      signatureImplied: false,
      activationImplied: false,
    },
    ...(rawDataPolicyField === "internalStationPlanRawDataShipped" ? {
      policy: { internalStationPlanRawDataShipped: false },
    } : {}),
  });
  const sources = compact({
    schema: "zugfolge-map-delivery-sources/v2",
    releaseId,
    sources: [{
      id: "basemap-protomaps",
      scope: "basemap",
      approved: true,
      license: "ODbL-1.0",
      version: `basemap-${packageVersion}`,
      attribution: "© OpenStreetMap-Mitwirkende; Basemap-Aufbereitung Protomaps",
      modifications: "Deterministische PMTiles-Aufbereitung für den öffentlichen Kartenrelease.",
    }],
    ...(options.assetInventoryPlanSha256 === null
      ? {}
      : { assetInventoryPlanSha256: options.assetInventoryPlanSha256 ?? "9".repeat(64) }),
    assetNotices: notices,
  });
  const baseFiles: FixtureFile[] = [
    { id: "basemap", kind: "basemap", installPath: "basemap.pmtiles", bytes: Buffer.from("basemap") },
    { id: "glyph", kind: "glyph", installPath: "assets/fonts/font.pbf", bytes: glyphBytes },
    { id: "infrastructure", kind: "infrastructure", installPath: "infra.pmtiles", bytes: Buffer.from("infra") },
    { id: "quality", kind: "quality-manifest", installPath: "manifests/quality.json", bytes: quality },
    { id: "read-model", kind: "read-model", installPath: "read-model.sqlite", bytes: Buffer.from("read-model") },
    { id: "sprite", kind: "sprite", installPath: "assets/sprites/dark.png", bytes: spriteBytes },
    { id: "style", kind: "style", installPath: "style.json", bytes: Buffer.from("{}") },
    {
      id: `operational-infrastructure-${packageVersion}`,
      kind: "operational-infrastructure-v2",
      installPath: "operational-infrastructure-v2.json",
      bytes: operationalBytes,
      infraReleaseId: options.operationalInfraReleaseId ?? releaseId,
      stateHash: OPERATIONAL_STATE_HASH,
    },
    {
      id: `operational-movement-routes-${packageVersion}`,
      kind: "movement-route-templates-v2",
      installPath: "operational-infrastructure-v2.movement-route-templates-v2.json",
      bytes: movementRouteTemplatesBytes,
    },
    {
      id: `timetable-transfer-demands-${packageVersion}`,
      kind: "timetable-transfer-demands-v2",
      installPath: "timetable-routes-v2.transfer-demands-v2.json",
      bytes: transferDemandsBytes,
    },
  ];
  const deliveryFiles = baseFiles.map((file) => {
    if (file.kind === "operational-infrastructure-v2" && options.deliveryOperationalStateHash !== undefined) {
      return { ...file, stateHash: options.deliveryOperationalStateHash };
    }
    if (file.kind === "movement-route-templates-v2" && options.deliveryMovementRouteTemplatesBytes !== undefined) {
      return { ...file, bytes: options.deliveryMovementRouteTemplatesBytes };
    }
    if (file.kind === "timetable-transfer-demands-v2" && options.deliveryTransferDemandsBytes !== undefined) {
      return { ...file, bytes: options.deliveryTransferDemandsBytes };
    }
    return file;
  });
  const unsignedRelease = {
    schema: "zugfolge-map-delivery-release/v2",
    releaseId,
    timetableYear: 2026,
    packageId: "zugfolge-map-deutschland",
    packageVersion,
    scope: {
      basemap: "world-z0-10-and-germany-z11-15",
      infrastructure: "germany-ebo-complete-visible-corpus",
      playableArea: "configured-separately-by-world",
    },
    artifacts: deliveryFiles.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length, sha256: sha256(bytes) })).sort((left, right) => left.id.localeCompare(right.id, "en")),
    bindings: {
      packageManifestSchema: "zugfolge-map-package/v2",
      infraReleaseSchema: "zugfolge-infra-release/v2",
      mapReleaseSchema: "zugfolge-map-release/v1",
      ...(options.infraReleaseHash === null ? {} : { infraReleaseHash: options.infraReleaseHash ?? HASH_B }),
      ...(options.mapReleaseHash === null ? {} : { mapReleaseHash: options.mapReleaseHash ?? HASH_C }),
      sourcesSha256: sha256(sources),
      qualitySha256: sha256(quality),
      ...(options.operationalProvenance === undefined ? {} : {
        operationalProvenanceSha256: sha256(`${JSON.stringify(sorted(options.operationalProvenance))}\n`),
      }),
      ...(options.operationalAuthority === undefined ? {} : {
        operationalAuthoritySha256: sha256(JSON.stringify(sorted(options.operationalAuthority))),
      }),
    },
    ...(options.operationalProvenance === undefined ? {} : { operationalProvenance: options.operationalProvenance }),
    ...(options.operationalAuthority === undefined ? {} : { operationalAuthority: options.operationalAuthority }),
    approvalGates: {
      rights: {
        status: "passed",
        sourceManifestSchema: "zugfolge-map-delivery-sources/v2",
        sourceCount: 1,
        assetGroupCount: 2,
        assetFileCount: 2,
      },
      quality: {
        status: "passed",
        reportSchema: "zugfolge-operational-infrastructure-quality-report/v1",
        visibleLayers: 10,
        visibleFeatures: 42,
        visibleMapClassCFeatureCount: visibleMapClassC,
        operationalClassCArtifactCount: 0,
        classCOrderable: false,
      },
      signature: {
        status: "missing",
        ...(options.unsignedSignatureReason === null
          ? {}
          : { reason: options.unsignedSignatureReason ?? "Kein produktiver privater Signaturschlüssel vorhanden; Aktivierung bleibt gesperrt." }),
        ...(options.unsignedSignatureExtraField === true ? { unexpected: true } : {}),
      },
    },
    ...(options.omitUnsignedReleaseHash === true ? {} : { releaseHash: options.unsignedReleaseHash ?? null }),
    signature: null as null | { readonly algorithm: "Ed25519"; readonly keyId: string; readonly valueBase64: string },
  };
  const releaseValue = signing === undefined
    ? unsignedRelease
    : (() => {
        const candidate = {
          ...unsignedRelease,
          approvalGates: {
            ...unsignedRelease.approvalGates,
            signature: { status: "passed", algorithm: "Ed25519", keyId: signing.keyId },
          },
        };
        const { releaseHash: ignoredReleaseHash, signature: ignoredSignature, ...payload } = candidate;
        void ignoredReleaseHash;
        void ignoredSignature;
        const releaseHash = sha256(canonical(payload));
        return {
          ...candidate,
          releaseHash,
          signature: {
            algorithm: "Ed25519" as const,
            keyId: signing.keyId,
            valueBase64: signEd25519(null, Buffer.from(releaseHash, "hex"), signing.privateKey).toString("base64"),
          },
        };
      })();
  const release = options.compactReleaseBytes === true ? compact(releaseValue) : canonical(releaseValue);
  const allFiles = [
    ...baseFiles,
    { id: "release", kind: "release-manifest", installPath: "manifests/release.json", bytes: release },
    { id: "sources", kind: "source-manifest", installPath: "manifests/sources.json", bytes: sources },
  ];
  const descriptors = allFiles.map(({ bytes, ...file }) => ({
    ...file,
    bytes: bytes.length,
    sha256: sha256(bytes),
    parts: [{ path: `parts/${file.id}.part-00001`, bytes: bytes.length, sha256: sha256(bytes) }],
  }));
  const manifest = canonical({
    schema: "zugfolge-map-package/v2",
    packageId: "zugfolge-map-deutschland",
    version: packageVersion,
    format: "directory-parts",
    partBytes: 100 * 1024 * 1024,
    artifacts: descriptors.filter(({ kind }) => ["basemap", "infrastructure"].includes(kind)),
    auxiliaryFiles: descriptors.filter(({ kind }) => !["basemap", "infrastructure"].includes(kind)),
  });
  return { manifest, parts: allFiles.map(({ id, bytes }) => ({ id, path: `parts/${id}.part-00001`, bytes })) };
}

async function* chunks(bytes: Buffer): AsyncIterable<Buffer> {
  const middle = Math.max(1, Math.floor(bytes.length / 2));
  yield bytes.subarray(0, middle);
  if (middle < bytes.length) yield bytes.subarray(middle);
}

const roots: string[] = [];

const verifyFixturePackage: InfraPackageVerifier = async (packageRoot) => {
  const manifest = await readFile(join(packageRoot, "manifest.json"));
  const value = JSON.parse(manifest.toString("utf8")) as { packageId: string; version: string };
  return { packageId: value.packageId, version: value.version, manifestSha256: sha256(manifest) };
};

async function staging(
  verifier?: InfraPackageVerifier,
  trustedReleaseKeys: Readonly<Record<string, string>> = {},
  nativeOperationalVerifier?: InfraOperationalV2NativeVerifier,
): Promise<InfraPackageStaging> {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-"));
  roots.push(root);
  return new InfraPackageStaging(root, {
    packageVerifier: verifier ?? verifyFixturePackage,
    trustedReleaseKeys,
    nativeOperationalVerifier,
  });
}

async function uploadFixture(
  service: InfraPackageStaging,
  importId: string,
  fixture: { readonly manifest: Buffer; readonly parts: readonly FixturePart[] },
) {
  await prepareFixtureUpload(service, importId, fixture);
  return service.finalize(importId);
}

async function prepareFixtureUpload(
  service: InfraPackageStaging,
  importId: string,
  fixture: { readonly manifest: Buffer; readonly parts: readonly FixturePart[] },
): Promise<void> {
  const manifestProof = { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) };
  await service.begin(importId, manifestProof);
  const accepted = await service.uploadManifest(importId, manifestProof, chunks(fixture.manifest));
  for (const part of fixture.parts) {
    const partId = accepted.parts.find(({ packagePath }) => packagePath === part.path)?.partId;
    expect(partId).toBeDefined();
    await service.uploadPart(
      importId,
      partId!,
      { bytes: part.bytes.length, sha256: sha256(part.bytes) },
      chunks(part.bytes),
    );
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  })));
});

describe("InfraPackageStaging", () => {
  it("akzeptiert das gemeinsame Transfer-v2-Producer-Golden mit exakten Paketbytes und SHA-256", async () => {
    const { golden, fixture } = await deliveryV2ProducerGoldenFixture();
    const service = await staging();
    const manifest = JSON.parse(fixture.manifest.toString("utf8")) as {
      readonly auxiliaryFiles: readonly { readonly id: string; readonly kind: string; readonly installPath: string; readonly bytes: number; readonly sha256: string }[];
    };
    const descriptor = manifest.auxiliaryFiles.find(({ kind }) => kind === "timetable-transfer-demands-v2");
    const part = fixture.parts.find(({ id }) => id === "timetable-transfer-demands-2026.1");
    expect(descriptor).toMatchObject({ installPath: "timetable-routes-v2.transfer-demands-v2.json" });
    expect(part).toBeDefined();
    expect(descriptor).toMatchObject({ bytes: part!.bytes.length, sha256: sha256(part!.bytes) });

    await expect(uploadFixture(service, "annual-2026-shared-v2-producer", fixture)).resolves.toMatchObject({
      deliveryReleaseId: golden.release.releaseId,
      signatureStatus: "missing",
      activationBlocker: "delivery-signature-missing",
      activationEligible: false,
    });
  });

  it("verwirft das gezielt auf Transfer-v1 mutierte gemeinsame Producer-Golden ohne Fallback", async () => {
    const { fixture } = await deliveryV2ProducerGoldenFixture();
    const legacyManifest = JSON.parse(fixture.manifest.toString("utf8")) as {
      auxiliaryFiles: Array<{ kind: string; installPath: string }>;
    };
    const transferDemands = legacyManifest.auxiliaryFiles.find(({ kind }) => kind === "timetable-transfer-demands-v2");
    expect(transferDemands).toBeDefined();
    transferDemands!.kind = "timetable-transfer-demands-v1";
    transferDemands!.installPath = "timetable-routes-v2.transfer-demands-v1.json";
    const legacyFixture = { ...fixture, manifest: canonical(legacyManifest) };

    const service = await staging();
    await expect(prepareFixtureUpload(service, "annual-2026-legacy-mutated-golden", legacyFixture))
      .rejects.toThrow("genau eine timetable-routes-v2.transfer-demands-v2.json");
  });

  it("akzeptiert die lokale Transfer-v2-Fixture mit exakten Paketbytes und SHA-256", async () => {
    const fixture = packageFixture();
    const manifest = JSON.parse(fixture.manifest.toString("utf8")) as {
      readonly auxiliaryFiles: readonly { readonly kind: string; readonly installPath: string; readonly bytes: number; readonly sha256: string }[];
    };
    const descriptor = manifest.auxiliaryFiles.find(({ kind }) => kind === "timetable-transfer-demands-v2");
    const part = fixture.parts.find(({ id }) => id === "timetable-transfer-demands-2026.1");
    expect(descriptor).toMatchObject({ installPath: "timetable-routes-v2.transfer-demands-v2.json" });
    expect(part).toBeDefined();
    expect(descriptor).toMatchObject({ bytes: part!.bytes.length, sha256: sha256(part!.bytes) });

    const service = await staging();
    const result = await uploadFixture(service, "annual-2026-local-v2-producer", fixture);
    expect(result).toMatchObject({
      deliveryReleaseId: "infra-deutschland-2026.1",
      signatureStatus: "missing",
      nativeOperationalValidationStatus: "missing",
      activationBlocker: "delivery-signature-missing",
      activationEligible: false,
    });
  });

  it("verwirft eine inhaltlich gueltige Signatur ueber nichtkanonisch kompakt serialisierte Delivery-Bytes", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "delivery-noncanonical-bytes";
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey }, { compactReleaseBytes: true });
    const service = await staging(undefined, {
      [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });

    await expect(uploadFixture(service, "noncanonical-delivery-release-bytes", fixture))
      .rejects.toThrow(/release\.json ist nicht kanonisch serialisiert/u);
  });

  it("verwirft PKCS8-Private-Key, RSA-SPKI und ungueltige Delivery-Vertrauensanker", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const { publicKey: rsaPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const keyId = "delivery-public-key-boundary";
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey });
    const nativeOperationalVerifier = vi.fn<InfraOperationalV2NativeVerifier>(async ({ expectedInfraReleaseId }) => ({
      schema: "operational-infrastructure-v2",
      infraReleaseId: expectedInfraReleaseId,
      stateHash: OPERATIONAL_STATE_HASH,
    }));
    const invalidAnchors = [
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      rsaPublicKey.export({ type: "spki", format: "pem" }).toString(),
      "kein PEM",
    ];

    for (const [index, invalidAnchor] of invalidAnchors.entries()) {
      const service = await staging(undefined, { [keyId]: invalidAnchor }, nativeOperationalVerifier);
      await expect(uploadFixture(service, `invalid-delivery-anchor-${index}`, fixture))
        .rejects.toThrow(`Delivery-Signaturschlüssel '${keyId}' ist ungültig.`);
    }
    expect(nativeOperationalVerifier).not.toHaveBeenCalled();
  });

  it("führt eine CPU-intensive PMTiles-nahe Transportprüfung außerhalb des Event Loops aus", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-verifier-module-"));
    roots.push(root);
    const modulePath = join(root, "verifier.mjs");
    const packageRoot = join(root, "package");
    await mkdir(packageRoot);
    await writeFile(modulePath, `
import { gzipSync, gunzipSync } from "node:zlib";
const compressedDirectory = gzipSync(Buffer.alloc(1024 * 1024, 0x61));
export function createOperationalInfrastructureV2ExecutableVerifier() {
  throw new Error("synchroner nativer Dateiverifier darf im Fastify-Prozess nicht erzeugt werden");
}
export async function verifyMapPackage() {
  throw new Error("vollständiger CLI-Prüfer darf im Fastify-Prozess nicht laufen");
}
export async function verifyMapPackageTransport(observedPackageRoot) {
  const deadline = performance.now() + 250;
  let directoryAccumulator = 0;
  while (performance.now() < deadline) {
    directoryAccumulator ^= gunzipSync(compressedDirectory).length;
  }
  if (typeof observedPackageRoot !== "string" || observedPackageRoot === "") throw new Error("falsche Paketwurzel");
  if (!Number.isInteger(directoryAccumulator)) throw new Error("ungueltige Directory-Pruefung");
  return {
    manifest: { packageId: "zugfolge-map-deutschland", version: "2026.3" },
    manifestSha256: "${HASH_A}",
  };
}
`, "utf8");

    const verifier = await createLocalMapPackageVerifier(modulePath);
    let heartbeatTicks = 0;
    let verificationCompleted = false;
    const heartbeat = setInterval(() => { heartbeatTicks += 1; }, 5);
    const verification = verifier(packageRoot);
    void verification.finally(() => { verificationCompleted = true; });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 60));
    clearInterval(heartbeat);
    expect(heartbeatTicks).toBeGreaterThanOrEqual(3);
    expect(verificationCompleted).toBe(false);
    await expect(verification).resolves.toEqual({
      packageId: "zugfolge-map-deutschland",
      version: "2026.3",
      manifestSha256: HASH_A,
    });
  });

  it("verwirft ein lokales Paketprüfmodul ohne getrennten Transportprüfer", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-verifier-missing-"));
    roots.push(root);
    const modulePath = join(root, "verifier.mjs");
    await writeFile(modulePath, "export async function verifyMapPackage() { throw new Error('darf nicht laufen'); }\n", "utf8");

    await expect(createLocalMapPackageVerifier(modulePath))
      .rejects.toThrow("exportiert verifyMapPackageTransport nicht");
  });

  it("begrenzt Worker-Laufzeit, Ausgabe und Warteschlange fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-worker-limits-"));
    roots.push(root);
    const timeoutModulePath = join(root, "timeout-verifier.mjs");
    await writeFile(timeoutModulePath, `
export function verifyMapPackageTransport() {
  while (true) Math.imul(17, 19);
}
`, "utf8");
    // timeoutMs gilt bereits fuer den einmaligen Modulgraph-Probe. Zwei
    // Sekunden lassen normalen Worker-Start auch unter Suite-Last zu; der
    // eigentliche Pruefer terminiert dagegen niemals und muss sicher enden.
    const timed = await createLocalMapPackageVerifier(timeoutModulePath, { timeoutMs: 2_000 });
    await expect(timed(root)).rejects.toThrow("Zeitlimit");

    const slowModulePath = join(root, "slow-verifier.mjs");
    await writeFile(slowModulePath, `
export function verifyMapPackageTransport() {
  const deadline = performance.now() + 180;
  while (performance.now() < deadline) Math.imul(17, 19);
  return { manifest: { packageId: "zugfolge-map-deutschland", version: "2026.3" }, manifestSha256: "${HASH_A}" };
}
`, "utf8");

    const noisyModulePath = join(root, "noisy-verifier.mjs");
    await writeFile(noisyModulePath, `
export function verifyMapPackageTransport() {
  console.log("x".repeat(8_192));
  return { manifest: { packageId: "zugfolge-map-deutschland", version: "2026.3" }, manifestSha256: "${HASH_A}" };
}
`, "utf8");
    const boundedOutput = await createLocalMapPackageVerifier(noisyModulePath, { maxOutputBytes: 1_024 });
    await expect(boundedOutput(root)).rejects.toThrow("Ausgabelimit");

    const queued = await createLocalMapPackageVerifier(slowModulePath, {
      // Der Test prueft Queue-Bounds, nicht Scheduler-Latenz. Unter dem
      // vollparallelen Game-API-Lauf duerfen zwei korrekte Worker deshalb
      // nicht an einer kuenstlich knappen Testdeadline scheitern.
      timeoutMs: 60_000,
      maxConcurrent: 1,
      maxQueued: 1,
    });
    const first = queued(root);
    const second = queued(root);
    // Handler sofort anbinden: Auch bei extremer Suite-Last darf ein Fehler
    // nicht vor dem spaeteren Assertion-Await als unhandled erscheinen.
    const accepted = Promise.all([first, second]);
    const rejected = queued(root);
    await expect(rejected).rejects.toThrow("Zu viele Kartenpaket-Transportpruefungen");
    await expect(accepted).resolves.toHaveLength(2);
  }, 70_000);

  it("gibt den Parallelitätsslot erst nach dem tatsächlichen Ende eines hart terminierten CPU-Workers frei", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-worker-termination-slot-"));
    roots.push(root);
    const modulePath = join(root, "verifier.mjs");
    const logPath = join(root, "worker-starts.log");
    const firstRoot = join(root, "first-package");
    const secondRoot = join(root, "second-package");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    await Promise.all([
      writeFile(join(firstRoot, "request-id"), "first", "utf8"),
      writeFile(join(secondRoot, "request-id"), "second", "utf8"),
    ]);
    await writeFile(modulePath, `
import { pbkdf2Sync } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
export function verifyMapPackageTransport(packageRoot) {
  const requestId = readFileSync(join(packageRoot, "request-id"), "utf8");
  appendFileSync(${JSON.stringify(logPath)}, "start:" + requestId + ":" + Date.now() + "\\n", "utf8");
  pbkdf2Sync("zugfolge", "worker-boundary", 10_000_000, 32, "sha256");
  appendFileSync(${JSON.stringify(logPath)}, "end:" + requestId + ":" + Date.now() + "\\n", "utf8");
  return { manifest: { packageId: requestId, version: "2026.3" }, manifestSha256: "${HASH_A}" };
}
`, "utf8");
    const verifier = await createLocalMapPackageVerifier(modulePath, {
      timeoutMs: 500,
      maxConcurrent: 1,
      maxQueued: 1,
    });

    const firstStartedAt = Date.now();
    const first = verifier(firstRoot).then(
      () => new Error("Erster Worker wurde unerwartet akzeptiert."),
      (error: unknown) => error,
    );
    await waitUntil(async () => {
      try {
        return (await readFile(logPath, "utf8")).includes("start:first:");
      } catch {
        return false;
      }
    });
    const second = verifier(secondRoot).then(
      () => new Error("Zweiter Worker wurde unerwartet akzeptiert."),
      (error: unknown) => error,
    );

    const firstError = await first;
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toContain("Zeitlimit");
    expect(Date.now() - firstStartedAt).toBeLessThan(1_000);
    const secondError = await second;
    expect(secondError).toBeInstanceOf(Error);
    expect((secondError as Error).message).toContain("Gesamtdeadline");
    await waitUntil(async () => (await readdir(root)).every((name) => !name.startsWith(".game-map-worker-")), 10_000);
    const markers = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => line.split(":").slice(0, 2).join(":"));
    expect(markers).toEqual(["start:first"]);
  }, 15_000);

  it("zählt die Queue-Wartezeit in dieselbe Gesamtdeadline ein", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-worker-queue-deadline-"));
    roots.push(root);
    const modulePath = join(root, "verifier.mjs");
    const firstRoot = join(root, "first-package");
    const secondRoot = join(root, "second-package");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    await writeFile(modulePath, `
export async function verifyMapPackageTransport() {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return { manifest: { packageId: "late", version: "2026.3" }, manifestSha256: "${HASH_A}" };
}
`, "utf8");
    const verifier = await createLocalMapPackageVerifier(modulePath, {
      timeoutMs: 250,
      maxConcurrent: 1,
      maxQueued: 1,
    });

    const [first, second] = await Promise.allSettled([verifier(firstRoot), verifier(secondRoot)]);
    expect(first).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("Zeitlimit") }) });
    expect(second).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("Gesamtdeadline") }) });
    await waitUntil(async () => (await readdir(root)).every((name) => !name.startsWith(".game-map-worker-")));
  });

  it("akzeptiert keinen frühen Erfolg vor einem späteren Throw und einer zweiten Fehlerantwort", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-worker-late-error-"));
    roots.push(root);
    const modulePath = join(root, "verifier.mjs");
    await writeFile(modulePath, `
import { parentPort } from "node:worker_threads";
export function verifyMapPackageTransport() {
  parentPort.postMessage({ ok: true, value: { packageId: "forged", version: "2026.3", manifestSha256: "${HASH_A}" } });
  throw new Error("spaeter Verifierfehler");
}
`, "utf8");
    const verifier = await createLocalMapPackageVerifier(modulePath);

    await expect(verifier(root)).rejects.toThrow("mehr als eine Antwort");
  });

  it("räumt eine bei harter Termination zurückgelassene Map-Hilfswurzel außerhalb des Workers sicher auf", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-worker-cleanup-"));
    roots.push(root);
    const modulePath = join(root, "verifier.mjs");
    const packageRoot = join(root, "package");
    await mkdir(packageRoot);
    await writeFile(modulePath, `
import { mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
export async function verifyMapPackageTransport(packageRoot) {
  const temporaryRoot = await mkdtemp(join(dirname(packageRoot), ".map-auxiliary-verifying-"));
  await writeFile(join(temporaryRoot, "orphan"), "must-be-removed", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
`, "utf8");
    const verifier = await createLocalMapPackageVerifier(modulePath, { timeoutMs: 5_000 });

    await expect(verifier(packageRoot)).rejects.toThrow("Zeitlimit");
    await waitUntil(async () => (await readdir(root)).every(
      (name) => !name.startsWith(".game-map-worker-") && !name.startsWith(".map-auxiliary-verifying-"),
    ));
  }, 15_000);

  it("verwirft ein nach dem Start ausgetauschtes Transportprüfmodul", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-worker-identity-"));
    roots.push(root);
    const modulePath = join(root, "verifier.mjs");
    await writeFile(modulePath, `
export function verifyMapPackageTransport() {
  return { manifest: { packageId: "zugfolge-map-deutschland", version: "2026.3" }, manifestSha256: "${HASH_A}" };
}
`, "utf8");
    const verifier = await createLocalMapPackageVerifier(modulePath);
    await writeFile(modulePath, `
export function verifyMapPackageTransport() {
  return { manifest: { packageId: "ausgetauscht", version: "2026.3" }, manifestSha256: "${HASH_B}" };
}
`, "utf8");

    await expect(verifier(root)).rejects.toThrow("seit dem Prozessstart ausgetauscht");
  });

  it("erkennt einen Modulaustausch im Importfenster vor dem ersten Prüferaufruf", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-worker-import-race-"));
    roots.push(root);
    const modulePath = join(root, "verifier.mjs");
    const markerPath = join(root, "import-started.marker");
    const releasePath = join(root, "continue-import.marker");
    await writeFile(modulePath, `
import { access, writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(markerPath)}, "started", "utf8");
for (;;) {
  try {
    await access(${JSON.stringify(releasePath)});
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export function verifyMapPackageTransport() {
  return { manifest: { packageId: "zugfolge-map-deutschland", version: "2026.3" }, manifestSha256: "${HASH_A}" };
}
`, "utf8");

    const creation = createLocalMapPackageVerifier(modulePath, { timeoutMs: 10_000 });
    const creationOutcome = creation.then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await waitUntil(async () => {
      try {
        return (await readFile(markerPath, "utf8")) === "started";
      } catch {
        return false;
      }
    });
    await writeFile(modulePath, `
export function verifyMapPackageTransport() {
  return { manifest: { packageId: "ausgetauscht", version: "2026.3" }, manifestSha256: "${HASH_B}" };
    }
`, "utf8");
    await writeFile(releasePath, "continue", "utf8");

    const outcome = await creationOutcome;
    expect(outcome.status).toBe("rejected");
    expect(outcome.status === "rejected" ? outcome.error : undefined).toEqual(
      expect.objectContaining({ message: expect.stringContaining("waehrend der Pruefung ausgetauscht") }),
    );
  }, 15_000);

  it("pinnt den transitiven lokalen ESM-Abhängigkeitsgraphen einschließlich Dependency-SHA", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-worker-dependency-"));
    roots.push(root);
    const modulePath = join(root, "verifier.mjs");
    const dependencyPath = join(root, "dep.mjs");
    const trustedDependency = 'export const packageId = "trusted-a";\n';
    const forgedDependency = 'export const packageId = "forged!-b";\n';
    expect(Buffer.byteLength(forgedDependency)).toBe(Buffer.byteLength(trustedDependency));
    await writeFile(dependencyPath, trustedDependency, "utf8");
    await writeFile(modulePath, `
import { packageId } from "./dep.mjs";
export function verifyMapPackageTransport() {
  return { manifest: { packageId, version: "2026.3" }, manifestSha256: "${HASH_A}" };
}
`, "utf8");
    const verifier = await createLocalMapPackageVerifier(modulePath);
    await writeFile(dependencyPath, forgedDependency, "utf8");

    await expect(verifier(root)).rejects.toThrow("ESM-Abhaengigkeit wurde seit dem Prozessstart ausgetauscht");
  });

  it("blockiert einen Entry-A-nach-B-nach-A-Austausch im Loaderfenster", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-worker-entry-aba-"));
    roots.push(root);
    const modulePath = join(root, "verifier.mjs");
    const markerPath = join(root, "before-import.marker");
    const trustedEntry = `
export function verifyMapPackageTransport() {
  return { manifest: { packageId: "trusted-a", version: "2026.3" }, manifestSha256: "${HASH_A}" };
}
`;
    const forgedSelfRestoringEntry = `
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
writeFileSync(fileURLToPath(import.meta.url), ${JSON.stringify(trustedEntry)}, "utf8");
export function verifyMapPackageTransport() {
  return { manifest: { packageId: "forged-b", version: "2026.3" }, manifestSha256: "${HASH_B}" };
}
`;
    await writeFile(modulePath, trustedEntry, "utf8");
    const verifier = await createLocalMapPackageVerifier(modulePath, {
      timeoutMs: 2_000,
      beforeImportDelayMs: 500,
      beforeImportMarkerPath: markerPath,
    });
    const verification = verifier(root);
    let workerReady = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        workerReady = (await readFile(markerPath, "utf8")) === "ready";
      } catch {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      if (workerReady) break;
    }
    expect(workerReady).toBe(true);
    await writeFile(modulePath, forgedSelfRestoringEntry, "utf8");

    await expect(verification).rejects.toThrow("ESM-Abhaengigkeit wurde seit dem Prozessstart ausgetauscht");
    expect(await readFile(modulePath, "utf8")).toBe(forgedSelfRestoringEntry);
    await writeFile(modulePath, trustedEntry, "utf8");
  });

  it("bindet die Odoo-Finalisierung dauerhaft an eine frische Einmalnonce und erlaubt nur idempotente Wiederholung", async () => {
    const fixture = packageFixture();
    const service = await staging();
    const importId = "annual-2026-finalization-binding";
    await uploadFixture(service, importId, fixture);
    const firstChallenge = {
      schema: "zugfolge-infra-package-finalization-challenge/v1" as const,
      nonce: "1".repeat(64),
      requestedAt: new Date().toISOString(),
    };
    const first = await service.finalizeForOdoo(importId, firstChallenge);
    expect(first).toMatchObject({
      finalizationChallenge: firstChallenge,
      operationalStateHash: null,
      signatureStatus: "missing",
      nativeOperationalValidationStatus: "missing",
      activationBlocker: "delivery-signature-missing",
      activationEligible: false,
    });

    const retry = await service.finalizeForOdoo(importId, {
      ...firstChallenge,
      requestedAt: new Date().toISOString(),
    });
    expect(retry).toEqual(first);
    await expect(service.begin(importId, {
      bytes: fixture.manifest.length,
      sha256: sha256(fixture.manifest),
    })).resolves.toEqual({
      status: "finalized",
      finalizationChallenge: firstChallenge,
      finalizedAt: first.finalizedAt,
      qualification: {
        packageId: first.packageId,
        version: first.version,
        manifestSha256: first.manifestSha256,
        deliveryReleaseId: first.deliveryReleaseId,
        operationalStateHash: first.operationalStateHash,
        operationalProvenanceStatus: first.operationalProvenanceStatus,
        operationalProvenanceSha256: first.operationalProvenanceSha256,
        operationalExecutionProofSha256: first.operationalExecutionProofSha256,
        operationalValidatorSha256: first.operationalValidatorSha256,
        operationalAuthorityStatus: first.operationalAuthorityStatus,
        operationalAuthoritySha256: first.operationalAuthoritySha256,
        operationalRebuildAttestationSha256: first.operationalRebuildAttestationSha256,
        operationalExecutionAuthorityAttestationSha256: first.operationalExecutionAuthorityAttestationSha256,
        operationalOuterExecutionReceiptSha256: first.operationalOuterExecutionReceiptSha256,
        operationalOuterExecutionCompletionSha256: first.operationalOuterExecutionCompletionSha256,
        operationalAuthoritySourceCommit: first.operationalAuthoritySourceCommit,
        signatureStatus: first.signatureStatus,
        nativeOperationalValidationStatus: first.nativeOperationalValidationStatus,
        activationBlocker: first.activationBlocker,
        activationEligible: first.activationEligible,
      },
    });
    await expect(service.finalizeForOdoo(importId, {
      ...firstChallenge,
      nonce: "2".repeat(64),
      requestedAt: new Date().toISOString(),
    })).rejects.toThrow("Finalisierungsnonce");
    await expect(service.finalizeForOdoo(importId, {
      ...firstChallenge,
      requestedAt: "2026-01-01T00:00:00.000Z",
    })).rejects.toThrow("abgelaufen");
  }, 15_000);

  it("leitet den Weltkandidaten nur aus einer signierten Odoo-Finalisierung ab und trennt Paket- und Infra-Hash", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "delivery-2026-activation-candidate";
    const trustedReleaseKeys = {
      [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const nativeOperationalVerifier: InfraOperationalV2NativeVerifier = async ({ expectedInfraReleaseId }) => ({
      schema: "operational-infrastructure-v2",
      infraReleaseId: expectedInfraReleaseId,
      stateHash: OPERATIONAL_STATE_HASH,
    });
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey });
    const service = await staging(undefined, trustedReleaseKeys, nativeOperationalVerifier);
    const importId = "annual-2026-activation-candidate";
    await prepareFixtureUpload(service, importId, fixture);
    const finalized = await service.finalizeForOdoo(importId, {
      schema: "zugfolge-infra-package-finalization-challenge/v1",
      nonce: "6".repeat(64),
      requestedAt: new Date().toISOString(),
    });

    const activation = await service.activationCandidate(importId);

    expect(activation).toMatchObject({
      releaseId: "infra-deutschland-2026.1",
      releaseHash: HASH_B,
      timetableYear: 2026,
      packageManifestSha256: finalized.manifestSha256,
      signatureProof: {
        schema: "zugfolge-infra-package-activation-proof/v1",
        packageManifestSha256: finalized.manifestSha256,
        infraReleaseHash: HASH_B,
        signatureStatus: "verified",
        nativeOperationalValidationStatus: "verified",
        operationalStateHash: OPERATIONAL_STATE_HASH,
      },
      coverageReport: {
        classASections: 0,
        classBSections: 1,
        classCSections: 0,
        orderableClassCSections: 0,
      },
      rightsReport: { approved: true, sourceIds: ["basemap-protomaps"] },
    });
    expect(activation.releaseHash).not.toBe(activation.packageManifestSha256);

    const genericImportId = "annual-2026-activation-without-odoo";
    await uploadFixture(service, genericImportId, fixture);
    await expect(service.activationCandidate(genericImportId))
      .rejects.toThrow("keine persistierte Odoo-Finalisierungsbindung");
  }, 15_000);

  it("fuehrt das aktuelle 2026.5-Paket mit integrierter Provenienz bis an die Alpha-Aktivierungsgrenze", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "delivery-2026-5-alpha";
    const trustedReleaseKeys = {
      [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const provenance = integratedOperationalProvenance();
    const provenanceProof = validateInfraPackageOperationalProvenance(provenance);
    const authority = integratedOperationalAuthority();
    const authorityProof = validateInfraPackageOperationalAuthority(authority);
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey }, {
      packageVersion: "2026.5",
      operationalProvenance: provenance,
      operationalAuthority: authority,
    });
    const nativeOperationalVerifier: InfraOperationalV2NativeVerifier = async ({ expectedInfraReleaseId }) => ({
      schema: "operational-infrastructure-v2",
      infraReleaseId: expectedInfraReleaseId,
      stateHash: OPERATIONAL_STATE_HASH,
    });
    const service = await staging(undefined, trustedReleaseKeys, nativeOperationalVerifier);
    const importId = "annual-2026-5-alpha-activation";
    await prepareFixtureUpload(service, importId, fixture);
    const finalized = await service.finalizeForOdoo(importId, {
      schema: "zugfolge-infra-package-finalization-challenge/v1",
      nonce: "5".repeat(64),
      requestedAt: new Date().toISOString(),
    });
    const activation = await service.activationCandidate(importId);

    expect(finalized).toMatchObject({
      version: "2026.5",
      deliveryReleaseId: "infra-deutschland-2026.5",
      operationalProvenanceStatus: "verified",
      operationalProvenanceSha256: provenanceProof.sha256,
      operationalExecutionProofSha256: provenanceProof.executionProofSha256,
      operationalValidatorSha256: provenanceProof.validatorSha256,
      operationalAuthorityStatus: "verified",
      operationalAuthoritySha256: authorityProof.sha256,
      operationalRebuildAttestationSha256: authorityProof.rebuildAttestationSha256,
      operationalExecutionAuthorityAttestationSha256: authorityProof.executionAuthorityAttestationSha256,
      operationalOuterExecutionReceiptSha256: authorityProof.outerExecutionReceiptSha256,
      operationalOuterExecutionCompletionSha256: authorityProof.outerExecutionCompletionSha256,
      operationalAuthoritySourceCommit: authorityProof.sourceCommit,
      activationEligible: true,
    });
    expect(activation).toMatchObject({
      releaseId: "infra-deutschland-2026.5",
      signatureProof: {
        schema: "zugfolge-infra-package-activation-proof/v2",
        operationalProvenanceStatus: "verified",
        operationalProvenanceSha256: provenanceProof.sha256,
        operationalExecutionProofSha256: provenanceProof.executionProofSha256,
        operationalValidatorSha256: provenanceProof.validatorSha256,
        operationalAuthorityStatus: "verified",
        operationalAuthoritySha256: authorityProof.sha256,
        operationalRebuildAttestationSha256: authorityProof.rebuildAttestationSha256,
        operationalExecutionAuthorityAttestationSha256: authorityProof.executionAuthorityAttestationSha256,
        operationalOuterExecutionReceiptSha256: authorityProof.outerExecutionReceiptSha256,
        operationalOuterExecutionCompletionSha256: authorityProof.outerExecutionCompletionSha256,
        operationalAuthoritySourceCommit: authorityProof.sourceCommit,
      },
    });

    const alphaClient = new PGlite();
    try {
      const alphaDb = drizzle(alphaClient, { schema: databaseSchema });
      await migrate(alphaDb, { migrationsFolder: MIGRATIONS_FOLDER });
      const worldId = "55555555-5555-4555-8555-555555555555";
      const epoch = new Date("2026-01-01T00:00:00.000Z");
      await alphaDb.insert(worlds).values({ id: worldId, name: "2026.5-Provenienzwelt", schedulePeriodWeeks: 3, epoch });
      await alphaDb.insert(alphaWorldProfiles).values({
        worldId,
        profileKind: "test",
        regionId: "deutschland-ebo-operational-v2",
        regionVariant: "B",
        worldSeed: 42n,
        accelerationFactor: 60,
        infraReleaseHash: "e".repeat(64),
        timetableReleaseHash: "1".repeat(64),
        fleetReleaseHash: "2".repeat(64),
        economyReleaseHash: "3".repeat(64),
        blueprint: { schemaVersion: "zugfolge-alpha-world-blueprint/v1" },
        blueprintHash: "4".repeat(64),
        currentPeriod: 0,
        state: "running",
        startedAtS: 0,
      });
      const safety: InfraActivationSafety = { verify: async () => ({
        safe: true,
        conflictCount: 0,
        invalidPathCount: 0,
        invalidCirculationCount: 0,
        invalidContractCount: 0,
        invariantOneProofHash: "f".repeat(64),
        explanation: "2026.5-Integrationsfixture ist konfliktfrei.",
      }) };
      const alpha = new InfraUpdateService(alphaDb, trustedReleaseKeys, safety);
      const substitutions: readonly [string, (value: any) => void][] = [
        ["provenanceSha", (value) => { value.signatureProof.operationalProvenanceSha256 = "f".repeat(64); }],
        ["executionProofSha", (value) => { value.signatureProof.operationalExecutionProofSha256 = "f".repeat(64); }],
        ["validatorSha", (value) => { value.signatureProof.operationalValidatorSha256 = "f".repeat(64); }],
        ["authoritySha", (value) => { value.signatureProof.operationalAuthoritySha256 = "f".repeat(64); }],
        ["rebuildBundleSha", (value) => { value.signatureProof.operationalRebuildAttestationSha256 = "f".repeat(64); }],
        ["executionBundleSha", (value) => { value.signatureProof.operationalExecutionAuthorityAttestationSha256 = "f".repeat(64); }],
        ["outerReceiptSha", (value) => { value.signatureProof.operationalOuterExecutionReceiptSha256 = "f".repeat(64); }],
        ["outerCompletionSha", (value) => { value.signatureProof.operationalOuterExecutionCompletionSha256 = "f".repeat(64); }],
        ["sourceCommit", (value) => { value.signatureProof.operationalAuthoritySourceCommit = "f".repeat(40); }],
        ["operationalArtifactSha", (value) => { value.operationalInfrastructure.sha256 = "f".repeat(64); }],
        ["operationalArtifactBytes", (value) => { value.operationalInfrastructure.bytes += 1; }],
        ["operationalArtifactState", (value) => {
          const stateHash = "f".repeat(64);
          value.operationalInfrastructure.stateHash = stateHash;
          value.signatureProof.operationalStateHash = stateHash;
          value.impactPreview.operationalStateHash = stateHash;
        }],
        ["releaseId", (value) => {
          value.releaseId = "infra-deutschland-2026.5-near-miss";
          value.signatureProof.deliveryReleaseId = value.releaseId;
          value.operationalInfrastructure.infraReleaseId = value.releaseId;
        }],
        ["timetableYear", (value) => {
          value.timetableYear = 2027;
          value.signatureProof.timetableYear = 2027;
        }],
        ["infraReleaseHash", (value) => {
          value.releaseHash = "f".repeat(64);
          value.signatureProof.infraReleaseHash = value.releaseHash;
        }],
      ];
      for (const [label, mutate] of substitutions) {
        const substituted = structuredClone(activation) as any;
        mutate(substituted);
        expect(substituted.signatureProof.valueBase64, label).toBe(activation.signatureProof.valueBase64);
        expect(substituted.signatureProof.deliveryReleaseBase64, label).toBe(activation.signatureProof.deliveryReleaseBase64);
        await expect(alpha.stageQualifiedPackageCandidateAt(
          worldId,
          substituted,
          new Date("2026-01-01T08:24:00.000Z"),
        ), label).rejects.toThrow();
        expect(await alphaDb.select().from(infraReleaseChanges), label).toHaveLength(0);
      }
      await expect(alpha.stageQualifiedPackageCandidateAt(
        worldId,
        activation,
        new Date("2026-01-01T08:24:00.000Z"),
      )).resolves.toMatchObject({
        releaseId: "infra-deutschland-2026.5",
        releaseHash: HASH_B,
        status: "validated",
        signature: {
          schema: "zugfolge-infra-package-activation-proof/v2",
          operationalProvenanceSha256: provenanceProof.sha256,
          operationalAuthoritySha256: authorityProof.sha256,
        },
      });
    } finally {
      await alphaClient.close();
    }

    const manipulatedProvenance = structuredClone(provenance);
    manipulatedProvenance.executionProof.runner.launcher.mode = "windows-exclusive-handle-launch-v1";
    const manipulatedFixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey }, {
      packageVersion: "2026.5",
      operationalProvenance: manipulatedProvenance,
      operationalAuthority: authority,
    });
    const manipulatedImportId = "annual-2026-5-manipulated-launcher";
    await prepareFixtureUpload(service, manipulatedImportId, manipulatedFixture);
    await expect(service.finalizeForOdoo(manipulatedImportId, {
      schema: "zugfolge-infra-package-finalization-challenge/v1",
      nonce: "7".repeat(64),
      requestedAt: new Date().toISOString(),
    })).rejects.toThrow(/Systemlauncher|Launcher/u);

    const manipulatedAuthority = structuredClone(authority);
    manipulatedAuthority.rebuild.subjects = manipulatedAuthority.rebuild.subjects
      .filter(({ file }) => file !== manipulatedAuthority.execution.predicate.planAuthority.plan.file);
    const manipulatedAuthorityFixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey }, {
      packageVersion: "2026.5",
      operationalProvenance: provenance,
      operationalAuthority: manipulatedAuthority,
    });
    const manipulatedAuthorityImportId = "annual-2026-5-manipulated-authority";
    await prepareFixtureUpload(service, manipulatedAuthorityImportId, manipulatedAuthorityFixture);
    await expect(service.finalizeForOdoo(manipulatedAuthorityImportId, {
      schema: "zugfolge-infra-package-finalization-challenge/v1",
      nonce: "8".repeat(64),
      requestedAt: new Date().toISOString(),
    })).rejects.toThrow(/Phase-1-Subject/u);
  }, 30_000);

  it("persistiert nach einem kontrolliert langen Prüfwarten keine abgelaufene Odoo-Finalisierungsbindung", async () => {
    const fixture = packageFixture();
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-finalization-deadline-"));
    roots.push(root);
    const importId = "annual-2026-finalization-deadline";
    let nowMs = Date.parse("2026-12-13T00:00:00.000Z");
    let releaseVerification!: () => void;
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolvePromise) => { markVerificationStarted = resolvePromise; });
    const verificationGate = new Promise<void>((resolvePromise) => { releaseVerification = resolvePromise; });
    const verifier: InfraPackageVerifier = async (packageRoot) => {
      markVerificationStarted();
      await verificationGate;
      return verifyFixturePackage(packageRoot);
    };
    const service = new InfraPackageStaging(root, {
      packageVerifier: verifier,
      now: () => new Date(nowMs),
    });
    await prepareFixtureUpload(service, importId, fixture);
    const finalization = service.finalizeForOdoo(importId, {
      schema: "zugfolge-infra-package-finalization-challenge/v1",
      nonce: "8".repeat(64),
      requestedAt: new Date(nowMs).toISOString(),
    });
    await verificationStarted;
    nowMs += 65 * 60_000 + 1;
    releaseVerification();

    await expect(finalization).rejects.toThrow("Zeitfenster");
    await expect(readFile(join(root, ".finalizations", `${importId}.json`), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidiert terminale Odoo-Begin-Retries gegen Stage, Delivery-Keyring und nativen Validator", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "delivery-2026-terminal-retry";
    const trustedReleaseKeys = {
      [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey });
    const validNativeReceipt: InfraOperationalV2NativeVerifier = async ({ expectedInfraReleaseId }) => ({
      schema: "operational-infrastructure-v2",
      infraReleaseId: expectedInfraReleaseId,
      stateHash: OPERATIONAL_STATE_HASH,
    });
    const service = await staging(undefined, trustedReleaseKeys, validNativeReceipt);
    const importId = "annual-2026-terminal-revalidation";
    await uploadFixture(service, importId, fixture);
    await service.finalizeForOdoo(importId, {
      schema: "zugfolge-infra-package-finalization-challenge/v1",
      nonce: "7".repeat(64),
      requestedAt: new Date().toISOString(),
    });
    const root = roots.at(-1)!;
    const manifest = { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) };

    const rejectedStageVerifier = vi.fn<InfraPackageVerifier>(async () => {
      throw new Error("aktuelle Stagingprüfung abgelehnt");
    });
    const stageRejected = new InfraPackageStaging(root, {
      packageVerifier: rejectedStageVerifier,
      trustedReleaseKeys,
      nativeOperationalVerifier: validNativeReceipt,
    });
    await expect(stageRejected.beginForOdoo(importId, manifest))
      .rejects.toThrow("aktuelle Stagingprüfung abgelehnt");
    expect(rejectedStageVerifier).toHaveBeenCalledOnce();

    const revokedNativeVerifier = vi.fn<InfraOperationalV2NativeVerifier>(validNativeReceipt);
    const keyRevoked = new InfraPackageStaging(root, {
      packageVerifier: verifyFixturePackage,
      trustedReleaseKeys: {},
      nativeOperationalVerifier: revokedNativeVerifier,
    });
    await expect(keyRevoked.beginForOdoo(importId, manifest))
      .rejects.toThrow("ist nicht vertrauenswürdig");
    expect(revokedNativeVerifier).not.toHaveBeenCalled();

    const changedNativeVerifier = vi.fn<InfraOperationalV2NativeVerifier>(async ({ expectedInfraReleaseId }) => ({
      schema: "operational-infrastructure-v2",
      infraReleaseId: expectedInfraReleaseId,
      stateHash: "e".repeat(64),
    }));
    const nativeRejected = new InfraPackageStaging(root, {
      packageVerifier: verifyFixturePackage,
      trustedReleaseKeys,
      nativeOperationalVerifier: changedNativeVerifier,
    });
    await expect(nativeRejected.beginForOdoo(importId, manifest))
      .rejects.toThrow("Native Operational-v2-Semantikvalidierung stimmt nicht mit der signierten Releasebindung überein");
    expect(changedNativeVerifier).toHaveBeenCalledOnce();

    const currentPackageVerifier = vi.fn<InfraPackageVerifier>(verifyFixturePackage);
    const currentNativeVerifier = vi.fn<InfraOperationalV2NativeVerifier>(validNativeReceipt);
    const accepted = new InfraPackageStaging(root, {
      packageVerifier: currentPackageVerifier,
      trustedReleaseKeys,
      nativeOperationalVerifier: currentNativeVerifier,
    });
    await expect(accepted.beginForOdoo(importId, manifest)).resolves.toMatchObject({
      status: "finalized",
      qualification: {
        deliveryReleaseId: "infra-deutschland-2026.1",
        operationalStateHash: OPERATIONAL_STATE_HASH,
        signatureStatus: "verified",
        nativeOperationalValidationStatus: "verified",
        activationEligible: true,
      },
    });
    expect(currentPackageVerifier).toHaveBeenCalledOnce();
    expect(currentNativeVerifier).toHaveBeenCalledOnce();
  });

  it("heilt nach Neustart das Crashfenster zwischen generischem Receipt und Odoo-Bindung", async () => {
    const fixture = packageFixture();
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-recovery-"));
    roots.push(root);
    const verifier: InfraPackageVerifier = async (packageRoot) => {
      const manifest = await readFile(join(packageRoot, "manifest.json"));
      const value = JSON.parse(manifest.toString("utf8")) as { packageId: string; version: string };
      return { packageId: value.packageId, version: value.version, manifestSha256: sha256(manifest) };
    };
    const importId = "annual-2026-finalization-restart-recovery";
    const manifestProof = { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) };
    const initial = new InfraPackageStaging(root, { packageVerifier: verifier });
    await uploadFixture(initial, importId, fixture);

    const restarted = new InfraPackageStaging(root, { packageVerifier: verifier });
    await expect(restarted.begin(importId, manifestProof)).resolves.toEqual({ status: "closed" });
    const challenge = {
      schema: "zugfolge-infra-package-finalization-challenge/v1" as const,
      nonce: "3".repeat(64),
      requestedAt: new Date().toISOString(),
    };
    const recovered = await restarted.finalizeForOdoo(importId, challenge);
    expect(recovered.finalizationChallenge).toEqual(challenge);

    const afterSecondRestart = new InfraPackageStaging(root, { packageVerifier: verifier });
    await expect(afterSecondRestart.begin(importId, manifestProof)).resolves.toMatchObject({
      status: "finalized",
      finalizationChallenge: challenge,
      finalizedAt: recovered.finalizedAt,
      qualification: {
        packageId: recovered.packageId,
        manifestSha256: recovered.manifestSha256,
      },
    });
  });

  it("verwendet bei parallelen Importen desselben signierten Pakets ein Stage mit genau einer nativen Prüfung je Finalize", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "delivery-2026-parallel-stage";
    const trustedReleaseKeys = {
      [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey });
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-parallel-stage-"));
    roots.push(root);
    const nativeOperationalVerifier = vi.fn<InfraOperationalV2NativeVerifier>(async ({ expectedInfraReleaseId }) => {
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      return {
        schema: "operational-infrastructure-v2",
        infraReleaseId: expectedInfraReleaseId,
        stateHash: OPERATIONAL_STATE_HASH,
      };
    });
    const packageVerifier = vi.fn<InfraPackageVerifier>(verifyFixturePackage);
    const service = new InfraPackageStaging(root, { packageVerifier, trustedReleaseKeys, nativeOperationalVerifier });
    await Promise.all([
      prepareFixtureUpload(service, "annual-2026-parallel-stage-a", fixture),
      prepareFixtureUpload(service, "annual-2026-parallel-stage-b", fixture),
    ]);

    const [first, second] = await Promise.all([
      service.finalize("annual-2026-parallel-stage-a"),
      service.finalize("annual-2026-parallel-stage-b"),
    ]);

    expect(second.stagePath).toBe(first.stagePath);
    expect(second).toEqual(first);
    expect(nativeOperationalVerifier).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("behandelt Windows-EPERM nur nach vollständiger Zielprüfung als sichere Stage-Kollision", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "delivery-2026-windows-stage";
    const trustedReleaseKeys = {
      [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey });
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-windows-stage-"));
    roots.push(root);
    const validReceipt: InfraOperationalV2NativeVerifier = async ({ expectedInfraReleaseId }) => ({
      schema: "operational-infrastructure-v2",
      infraReleaseId: expectedInfraReleaseId,
      stateHash: OPERATIONAL_STATE_HASH,
    });
    const initial = new InfraPackageStaging(root, {
      packageVerifier: verifyFixturePackage,
      trustedReleaseKeys,
      nativeOperationalVerifier: validReceipt,
    });
    await prepareFixtureUpload(initial, "annual-2026-windows-stage-initial", fixture);
    const staged = await initial.finalize("annual-2026-windows-stage-initial");

    const windowsRename = vi.fn(async () => {
      throw Object.assign(new Error("Windows-Ziel ist bereits nichtleer"), { code: "EPERM" });
    });
    const reusedNative = vi.fn<InfraOperationalV2NativeVerifier>(validReceipt);
    const reused = new InfraPackageStaging(root, {
      packageVerifier: verifyFixturePackage,
      trustedReleaseKeys,
      nativeOperationalVerifier: reusedNative,
      renamePackage: windowsRename,
    });
    await prepareFixtureUpload(reused, "annual-2026-windows-stage-reuse", fixture);
    await expect(reused.finalize("annual-2026-windows-stage-reuse")).resolves.toMatchObject({
      stagePath: staged.stagePath,
      nativeOperationalValidationStatus: "verified",
    });
    expect(reusedNative).toHaveBeenCalledOnce();
    expect(windowsRename).toHaveBeenCalledTimes(6);

    await writeFile(join(staged.stagePath, "manifest.json"), "{}\n", "utf8");
    const rejectedNative = vi.fn<InfraOperationalV2NativeVerifier>(validReceipt);
    const rejected = new InfraPackageStaging(root, {
      packageVerifier: verifyFixturePackage,
      trustedReleaseKeys,
      nativeOperationalVerifier: rejectedNative,
      renamePackage: windowsRename,
    });
    await prepareFixtureUpload(rejected, "annual-2026-windows-stage-rejected", fixture);
    await expect(rejected.finalize("annual-2026-windows-stage-rejected"))
      .rejects.toThrow("Vorhandenes Stagingziel gehoert zu einem anderen Paketmanifest");
    expect(rejectedNative).toHaveBeenCalledOnce();
  }, 15_000);

  it("führt bei einer Crash-Recovery-Kollision nur eine native Prüfung aus und revalidiert spätere terminale Retries", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "delivery-2026-crash-stage";
    const trustedReleaseKeys = {
      [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey });
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-crash-stage-"));
    roots.push(root);
    const receipt = async (expectedInfraReleaseId: string) => ({
      schema: "operational-infrastructure-v2" as const,
      infraReleaseId: expectedInfraReleaseId,
      stateHash: OPERATIONAL_STATE_HASH,
    });
    const crashNative = vi.fn<InfraOperationalV2NativeVerifier>(async ({ expectedInfraReleaseId }) => receipt(expectedInfraReleaseId));
    const crashing = new InfraPackageStaging(root, {
      packageVerifier: verifyFixturePackage,
      trustedReleaseKeys,
      nativeOperationalVerifier: crashNative,
      renamePackage: async () => {
        throw Object.assign(new Error("simulierter Crash vor Stage-Rename"), { code: "EIO" });
      },
    });
    await prepareFixtureUpload(crashing, "annual-2026-crash-stage-recovery", fixture);
    await expect(crashing.finalize("annual-2026-crash-stage-recovery"))
      .rejects.toThrow("simulierter Crash");
    expect(crashNative).toHaveBeenCalledOnce();

    const competingNative = vi.fn<InfraOperationalV2NativeVerifier>(async ({ expectedInfraReleaseId }) => receipt(expectedInfraReleaseId));
    const competing = new InfraPackageStaging(root, {
      packageVerifier: verifyFixturePackage,
      trustedReleaseKeys,
      nativeOperationalVerifier: competingNative,
    });
    await prepareFixtureUpload(competing, "annual-2026-crash-stage-competitor", fixture);

    let releaseRecovery!: () => void;
    let reportRecoveryEntered!: () => void;
    const recoveryEntered = new Promise<void>((resolvePromise) => { reportRecoveryEntered = resolvePromise; });
    const recoveryGate = new Promise<void>((resolvePromise) => { releaseRecovery = resolvePromise; });
    const recoveryNative = vi.fn<InfraOperationalV2NativeVerifier>(async ({ expectedInfraReleaseId }) => {
      reportRecoveryEntered();
      await recoveryGate;
      return receipt(expectedInfraReleaseId);
    });
    const recovering = new InfraPackageStaging(root, {
      packageVerifier: verifyFixturePackage,
      trustedReleaseKeys,
      nativeOperationalVerifier: recoveryNative,
    });
    const recovered = recovering.finalize("annual-2026-crash-stage-recovery");
    await recoveryEntered;
    const competitor = await competing.finalize("annual-2026-crash-stage-competitor");
    releaseRecovery();
    await expect(recovered).resolves.toMatchObject({ stagePath: competitor.stagePath });
    expect(recoveryNative).toHaveBeenCalledOnce();
    expect(competingNative).toHaveBeenCalledOnce();

    const terminalNative = vi.fn<InfraOperationalV2NativeVerifier>(async ({ expectedInfraReleaseId }) => receipt(expectedInfraReleaseId));
    const terminalRetry = new InfraPackageStaging(root, {
      packageVerifier: verifyFixturePackage,
      trustedReleaseKeys,
      nativeOperationalVerifier: terminalNative,
    });
    await expect(terminalRetry.finalize("annual-2026-crash-stage-recovery")).resolves.toMatchObject({
      stagePath: competitor.stagePath,
    });
    expect(terminalNative).toHaveBeenCalledOnce();
  }, 15_000);

  it("quittiert prozessuebergreifend konkurrierende Odoo-Retries derselben Nonce idempotent", async () => {
    const fixture = packageFixture();
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-package-race-"));
    roots.push(root);
    const verifier: InfraPackageVerifier = async (packageRoot) => {
      const manifest = await readFile(join(packageRoot, "manifest.json"));
      const value = JSON.parse(manifest.toString("utf8")) as { packageId: string; version: string };
      return { packageId: value.packageId, version: value.version, manifestSha256: sha256(manifest) };
    };
    const importId = "annual-2026-finalization-cross-process-race";
    await uploadFixture(new InfraPackageStaging(root, { packageVerifier: verifier }), importId, fixture);
    const firstService = new InfraPackageStaging(root, { packageVerifier: verifier });
    const secondService = new InfraPackageStaging(root, { packageVerifier: verifier });
    const requestedAt = Date.now();
    const baseChallenge = {
      schema: "zugfolge-infra-package-finalization-challenge/v1" as const,
      nonce: "4".repeat(64),
    };

    const [first, second] = await Promise.all([
      firstService.finalizeForOdoo(importId, {
        ...baseChallenge,
        requestedAt: new Date(requestedAt).toISOString(),
      }),
      secondService.finalizeForOdoo(importId, {
        ...baseChallenge,
        requestedAt: new Date(requestedAt + 1).toISOString(),
      }),
    ]);

    expect(second).toEqual(first);
    expect(first.finalizationChallenge.nonce).toBe(baseChallenge.nonce);
  });

  it("behandelt parallele Begin-, Manifest-, Part- und Finalize-Wiederholungen idempotent", async () => {
    const fixture = packageFixture();
    const service = await staging();
    const importId = "annual-2026-parallel";
    const manifestProof = { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) };
    const began = await Promise.all([
      service.begin(importId, manifestProof),
      service.begin(importId, manifestProof),
    ]);
    expect(began.map(({ status }) => status).sort()).toEqual(["created", "reused"]);
    const manifests = await Promise.all([
      service.uploadManifest(importId, manifestProof, chunks(fixture.manifest)),
      service.uploadManifest(importId, manifestProof, chunks(fixture.manifest)),
    ]);
    expect(manifests[0].parts).toEqual(manifests[1].parts);
    for (const part of fixture.parts) {
      const accepted = manifests[0].parts.find(({ packagePath }) => packagePath === part.path)!;
      const proof = { bytes: part.bytes.length, sha256: sha256(part.bytes) };
      const uploaded = await Promise.all([
        service.uploadPart(importId, accepted.partId, proof, chunks(part.bytes)),
        service.uploadPart(importId, accepted.partId, proof, chunks(part.bytes)),
      ]);
      expect(uploaded.map(({ status }) => status).sort()).toEqual(["reused", "stored"]);
    }
    const [first, second] = await Promise.all([service.finalize(importId), service.finalize(importId)]);
    expect(second).toEqual(first);
  }, 30_000);

  it("überträgt Teile idempotent, qualifiziert fail-closed und staged atomar", async () => {
    const fixture = packageFixture();
    const service = await staging();
    const importId = "annual-2026-test";
    await expect(service.begin(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) })).resolves.toEqual({ status: "created" });
    const accepted = await service.uploadManifest(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) }, chunks(fixture.manifest));
    expect(accepted.parts).toHaveLength(fixture.parts.length);
    for (const part of fixture.parts) {
      const partId = accepted.parts.find(({ packagePath }) => packagePath === part.path)?.partId;
      expect(partId).toBeDefined();
      const proof = { bytes: part.bytes.length, sha256: sha256(part.bytes) };
      await expect(service.uploadPart(importId, partId!, proof, chunks(part.bytes))).resolves.toEqual({ status: "stored" });
      await expect(service.uploadPart(importId, partId!, proof, chunks(part.bytes))).resolves.toEqual({ status: "reused" });
    }
    const first = await service.finalize(importId);
    expect(first).toMatchObject({
      deliveryReleaseId: "infra-deutschland-2026.1",
      signatureStatus: "missing",
      nativeOperationalValidationStatus: "missing",
      activationBlocker: "delivery-signature-missing",
      activationEligible: false,
    });
    await expect(service.begin(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) })).resolves.toEqual({ status: "closed" });
    await expect(service.begin(importId, { bytes: fixture.manifest.length, sha256: HASH_A })).rejects.toThrow("Abgeschlossene Import-ID gehört zu einem anderen Manifest");
    await expect(service.uploadManifest(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) }, chunks(fixture.manifest)))
      .rejects.toThrow("bereits endgültig abgeschlossen");
    const latePart = accepted.parts[0]!;
    const lateBytes = fixture.parts.find(({ path }) => path === latePart.packagePath)!.bytes;
    await expect(service.uploadPart(importId, latePart.partId, { bytes: lateBytes.length, sha256: sha256(lateBytes) }, chunks(lateBytes)))
      .rejects.toThrow("bereits endgültig abgeschlossen");
    const replays = await Promise.all([service.finalize(importId), service.finalize(importId), service.finalize(importId)]);
    expect(replays).toEqual([first, first, first]);
    const root = roots.at(-1)!;
    await expect(readFile(join(root, ".receiving", importId, "session.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const receipt = JSON.parse(await readFile(join(root, ".receipts", `${importId}.json`), "utf8")) as { uploadStatus: string };
    expect(receipt.uploadStatus).toBe("closed");
  }, 15_000);

  it("verlangt Operational-v2 und beide betrieblichen Sidecars genau einmal an kanonischen Pfaden", async () => {
    const fixture = packageFixture();
    const parsed = JSON.parse(fixture.manifest.toString("utf8")) as {
      auxiliaryFiles: Array<Record<string, unknown>>;
    };
    const withoutOperational = {
      ...parsed,
      auxiliaryFiles: parsed.auxiliaryFiles.filter(({ kind }) => kind !== "operational-infrastructure-v2"),
    };
    const withoutMovementRoutes = {
      ...parsed,
      auxiliaryFiles: parsed.auxiliaryFiles.filter(({ kind }) => kind !== "movement-route-templates-v2"),
    };
    const withoutTransferDemands = {
      ...parsed,
      auxiliaryFiles: parsed.auxiliaryFiles.filter(({ kind }) => kind !== "timetable-transfer-demands-v2"),
    };
    const misplacedMovementRoutes = structuredClone(parsed);
    misplacedMovementRoutes.auxiliaryFiles.find(({ kind }) => kind === "movement-route-templates-v2")!["installPath"] = "movement-routes.json";
    const misplacedTransferDemands = structuredClone(parsed);
    misplacedTransferDemands.auxiliaryFiles.find(({ kind }) => kind === "timetable-transfer-demands-v2")!["installPath"] = "transfer-demands.json";
    const withLegacyProjection = {
      ...parsed,
      auxiliaryFiles: [...parsed.auxiliaryFiles, {
        id: "train-projection",
        kind: "train-map-projection",
        installPath: "train-map-projection.sqlite",
        visibility: "public",
        mediaType: "application/vnd.sqlite3",
        bytes: 1,
        sha256: HASH_A,
        parts: [{ path: "parts/train-projection.part-00001", bytes: 1, sha256: HASH_A }],
      }],
    };
    for (const [importId, manifest, message] of [
      ["annual-2026-missing-operational", canonical(withoutOperational), "genau eine statische operational-infrastructure-v2.json"],
      ["annual-2026-missing-movement-routes", canonical(withoutMovementRoutes), "genau eine operational-infrastructure-v2.movement-route-templates-v2.json"],
      ["annual-2026-missing-transfer-demands", canonical(withoutTransferDemands), "genau eine timetable-routes-v2.transfer-demands-v2.json"],
      ["annual-2026-misplaced-movement-routes", canonical(misplacedMovementRoutes), "genau eine operational-infrastructure-v2.movement-route-templates-v2.json"],
      ["annual-2026-misplaced-transfer-demands", canonical(misplacedTransferDemands), "genau eine timetable-routes-v2.transfer-demands-v2.json"],
      ["annual-2026-legacy-projection", canonical(withLegacyProjection), "keine weltgebundene Zugpositionsprojektion"],
    ] as const) {
      const service = await staging();
      const proof = { bytes: manifest.length, sha256: sha256(manifest) };
      await service.begin(importId, proof);
      await expect(service.uploadManifest(importId, proof, chunks(manifest))).rejects.toThrow(message);
    }
  });

  it("verwirft eine im Deliverymanifest gefälschte Operational-v2-Zustandsbindung", async () => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, {
      deliveryOperationalStateHash: "e".repeat(64),
    });
    const service = await staging();
    await expect(uploadFixture(service, "annual-2026-forged-operational", fixture))
      .rejects.toThrow("bindet nicht exakt alle ausgelieferten Artefakte");
  });

  it("verwirft abweichende Transfer-Sidecar-Bytes zwischen Delivery- und Paketinventar", async () => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, {
      deliveryTransferDemandsBytes: Buffer.from('{"infraReleaseId":"infra-deutschland-2026.1","schema":"zugfolge-timetable-transfer-demands/v2","substituted":true}\n'),
    });
    const service = await staging();
    await expect(uploadFixture(service, "annual-2026-forged-transfer-inventory", fixture))
      .rejects.toThrow("bindet nicht exakt alle ausgelieferten Artefakte");
  });

  it("verwirft abweichende Movement-Sidecar-Bytes zwischen Delivery- und Paketinventar", async () => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, {
      deliveryMovementRouteTemplatesBytes: Buffer.from('{"infraReleaseId":"infra-deutschland-2026.1","schema":"movement-route-templates-v2","substituted":true}\n'),
    });
    const service = await staging();
    await expect(uploadFixture(service, "annual-2026-forged-movement-inventory", fixture))
      .rejects.toThrow("bindet nicht exakt alle ausgelieferten Artefakte");
  });

  it("verwirft einen Fahrwegbeleg ohne Bytebindung an das ausgelieferte Transfer-Sidecar", async () => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, {
      qualityTransferDemandsSha256: "e".repeat(64),
    });
    const service = await staging();
    await expect(uploadFixture(service, "annual-2026-forged-transfer-evidence", fixture))
      .rejects.toThrow("bindet nicht bytegenau das ausgelieferte Timetable-Transfer-Demands-v2-Artefakt");
  });

  it("verwirft einen Movement-Beleg ohne Bytebindung an das ausgelieferte Movement-Sidecar", async () => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, {
      qualityMovementRouteTemplatesSha256: "e".repeat(64),
    });
    const service = await staging();
    await expect(uploadFixture(service, "annual-2026-forged-movement-evidence", fixture))
      .rejects.toThrow("bindet nicht bytegenau das ausgelieferte Movement-Route-Templates-v2-Artefakt");
  });

  it("verwirft eine konsistent gefälschte Operational-v2-InfraRelease-ID", async () => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, {
      operationalInfraReleaseId: "infra-deutschland-fremd",
    });
    const service = await staging();
    await expect(uploadFixture(service, "annual-2026-foreign-operational", fixture))
      .rejects.toThrow("nicht an die Delivery-InfraRelease-ID gebunden");
  });

  it("akzeptiert sichtbare Kartenklasse C bei strikt geschlossener betrieblicher B=1/C=0-Qualität", async () => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, { visibleMapClassCFeatures: 2 });
    const service = await staging();
    await expect(uploadFixture(service, "annual-2026-visible-map-class-c", fixture)).resolves.toMatchObject({
      deliveryReleaseId: "infra-deutschland-2026.1",
      activationEligible: false,
    });
  });

  it.each([
    ["betriebliche Klasse C", "operational-class-c", { operationalClassCArtifacts: 1 }, /B=1\/C=0-Bilanz/],
    ["offenes Closure-Gate", "open-closure", { closureReceiptVerified: false }, /Qualitätsgate ist offen/],
    ["Umklassifizierung sichtbarer Karten-C", "map-c-reclassified", { mapClassCReclassified: true }, /deklariert sichtbare Karten-C um/],
    ["abweichender Fahrtenkettenbilanz", "journey-chain-mismatch", { qualityJourneyChainCount: 5 }, /Tagesumlauf-\/Transferabdeckung/],
  ] as const)("verwirft Operational-v2 bei %s", async (_label, importSuffix, options, expectedMessage) => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, options);
    const service = await staging();
    await expect(uploadFixture(service, `annual-2026-class-c-${importSuffix}`, fixture))
      .rejects.toThrow(expectedMessage);
  });

  it.each([
    ["fehlender InfraRelease-Hash", "missing-infra", { infraReleaseHash: null }],
    ["ungültiger InfraRelease-Hash", "invalid-infra", { infraReleaseHash: "kein-sha" }],
    ["fehlender MapRelease-Hash", "missing-map", { mapReleaseHash: null }],
    ["ungültiger MapRelease-Hash", "invalid-map", { mapReleaseHash: "kein-sha" }],
  ] as const)("verwirft Delivery-v2 mit %s", async (_label, importSuffix, options) => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, options);
    const service = await staging();
    await expect(uploadFixture(service, `annual-2026-${importSuffix}`, fixture))
      .rejects.toThrow(/Delivery bindings besitzt unerwartete oder fehlende Felder|Infra-\/Map-Release-Hüllen/);
  });

  it.each([
    ["fehlendem explizitem null-Releasehash", "missing-null-hash", { omitUnsignedReleaseHash: true }],
    ["behauptetem Releasehash", "claimed-hash", { unsignedReleaseHash: HASH_A }],
    ["fehlendem Signaturgrund", "missing-signature-reason", { unsignedSignatureReason: null }],
    ["leerem Signaturgrund", "blank-signature-reason", { unsignedSignatureReason: "   " }],
    ["zusätzlichem Signaturgate-Feld", "extra-signature-field", { unsignedSignatureExtraField: true }],
  ] as const)("verwirft unsignierte Delivery-v2 mit %s", async (_label, importSuffix, options) => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, options);
    const service = await staging();
    await expect(uploadFixture(service, `annual-2026-${importSuffix}`, fixture))
      .rejects.toThrow(/Delivery-Release besitzt unerwartete|Unsigniertes Delivery-Signaturgate|Grund, null-Signatur und null-Releasehash/);
  });

  it("verwirft einen bytegebundenen Quellenvertrag mit gefälschtem Assetbaum", async () => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, { assetTreeSha256: "f".repeat(64) });
    const service = await staging();
    await expect(uploadFixture(service, "annual-2026-forged-asset-tree", fixture))
      .rejects.toThrow(/Assetbaum/);
  });

  it.each([
    ["fehlendem", "missing", null],
    ["ungültigem", "invalid", "kein-sha"],
  ] as const)("verwirft Delivery-v2 mit %s Asset-Inventarplan-SHA", async (_label, suffix, assetInventoryPlanSha256) => {
    const fixture = packageFixture("nonPublicSourceRawDataShipped", undefined, { assetInventoryPlanSha256 });
    const service = await staging();
    await expect(uploadFixture(service, `annual-2026-asset-plan-${suffix}`, fixture))
      .rejects.toThrow(/Quellenvertrag|Asset-Inventarvertrag/);
  });

  it("blockiert eine gültig signierte v2-Delivery ohne native Operational-Semantikvalidierung präzise", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "delivery-2026-without-native";
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey });
    const service = await staging(undefined, {
      [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });

    await expect(uploadFixture(service, "annual-2026-signed-without-native", fixture)).resolves.toMatchObject({
      signatureStatus: "verified",
      nativeOperationalValidationStatus: "missing",
      activationBlocker: "operational-v2-native-validation-missing",
      activationEligible: false,
    });
  });

  it("qualifiziert eine vertrauenswürdig signierte Delivery erst nach passender nativer Operational-v2-Validierung", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "delivery-2026";
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey });
    const trustedReleaseKeys = {
      [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const nativeOperationalVerifier = vi.fn<InfraOperationalV2NativeVerifier>(async (input) => {
      expect(input.expectedInfraReleaseId).toBe("infra-deutschland-2026.1");
      expect(input.artifact).toMatchObject({
        id: "operational-infrastructure-2026.1",
        installPath: "operational-infrastructure-v2.json",
        sha256: sha256(Buffer.from('{"id":"infra-deutschland-2026.1","schema":"zugfolge-operational-infrastructure/v2"}\n')),
      });
      expect(input.artifact).not.toHaveProperty("stateHash");
      return {
        schema: "operational-infrastructure-v2",
        infraReleaseId: input.expectedInfraReleaseId,
        stateHash: OPERATIONAL_STATE_HASH,
      };
    });
    const service = await staging(undefined, trustedReleaseKeys, nativeOperationalVerifier);
    const importId = "annual-2026-signed";
    const manifestProof = { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) };
    await service.begin(importId, manifestProof);
    const accepted = await service.uploadManifest(importId, manifestProof, chunks(fixture.manifest));
    for (const part of fixture.parts) {
      const partId = accepted.parts.find(({ packagePath }) => packagePath === part.path)?.partId;
      expect(partId).toBeDefined();
      await service.uploadPart(
        importId,
        partId!,
        { bytes: part.bytes.length, sha256: sha256(part.bytes) },
        chunks(part.bytes),
      );
    }
    const first = await service.finalize(importId);
    expect(first).toMatchObject({
      deliveryReleaseId: "infra-deutschland-2026.1",
      signatureStatus: "verified",
      nativeOperationalValidationStatus: "verified",
      activationBlocker: null,
      activationEligible: true,
    });
    await expect(service.finalize(importId)).resolves.toEqual(first);

    const root = roots.at(-1)!;
    const packageVerifier: InfraPackageVerifier = async (packageRoot) => {
      const manifest = await readFile(join(packageRoot, "manifest.json"));
      const value = JSON.parse(manifest.toString("utf8")) as { packageId: string; version: string };
      return { packageId: value.packageId, version: value.version, manifestSha256: sha256(manifest) };
    };
    const restarted = new InfraPackageStaging(root, { packageVerifier, trustedReleaseKeys, nativeOperationalVerifier });
    await expect(restarted.finalize(importId)).resolves.toEqual(first);
    expect(nativeOperationalVerifier).toHaveBeenCalled();

    const receiptPath = join(root, ".receipts", `${importId}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown> & {
      qualification: Record<string, unknown>;
    };
    for (const invalidPair of [
      {
        signatureStatus: "missing",
        nativeOperationalValidationStatus: "verified",
        activationBlocker: null,
        activationEligible: true,
      },
      {
        signatureStatus: "verified",
        nativeOperationalValidationStatus: "missing",
        activationBlocker: null,
        activationEligible: true,
      },
      {
        signatureStatus: "verified",
        nativeOperationalValidationStatus: "verified",
        activationBlocker: "operational-v2-native-validation-missing",
        activationEligible: false,
      },
    ] as const) {
      await writeFile(receiptPath, `${JSON.stringify({
        ...receipt,
        qualification: { ...receipt.qualification, ...invalidPair },
      })}\n`, "utf8");
      const invalidRestart = new InfraPackageStaging(root, { packageVerifier, trustedReleaseKeys, nativeOperationalVerifier });
      await expect(invalidRestart.finalize(importId))
        .rejects.toThrow("Finalisierungsbeleg besitzt eine unzulässige Qualifikation.");
    }
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");

    const otherKey = generateKeyPairSync("ed25519").publicKey;
    const rejected = await staging(undefined, {
      [keyId]: otherKey.export({ type: "spki", format: "pem" }).toString(),
    });
    const rejectedId = "annual-2026-wrong-key";
    await rejected.begin(rejectedId, manifestProof);
    const rejectedParts = await rejected.uploadManifest(rejectedId, manifestProof, chunks(fixture.manifest));
    for (const part of fixture.parts) {
      const partId = rejectedParts.parts.find(({ packagePath }) => packagePath === part.path)?.partId;
      await rejected.uploadPart(
        rejectedId,
        partId!,
        { bytes: part.bytes.length, sha256: sha256(part.bytes) },
        chunks(part.bytes),
      );
    }
    await expect(rejected.finalize(rejectedId)).rejects.toThrow("keine gültige vertrauenswürdige Ed25519-Signatur");
  }, 30_000);

  it("verwirft einen nativen Operational-v2-Beleg mit abweichendem Zustandshash", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "delivery-2026-native-mismatch";
    const fixture = packageFixture("nonPublicSourceRawDataShipped", { keyId, privateKey });
    const service = await staging(
      undefined,
      { [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString() },
      async ({ expectedInfraReleaseId }) => ({
        schema: "operational-infrastructure-v2",
        infraReleaseId: expectedInfraReleaseId,
        stateHash: "e".repeat(64),
      }),
    );

    await expect(uploadFixture(service, "annual-2026-native-mismatch", fixture))
      .rejects.toThrow("Native Operational-v2-Semantikvalidierung stimmt nicht mit der signierten Releasebindung überein");
  });

  it.each([".receiving", ".receipts", ".finalizations", "staged"])("lehnt ein verlinktes Staging-Unterverzeichnis %s ab", async (directory) => {
    const fixture = packageFixture();
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-symlink-root-"));
    const target = await mkdtemp(join(tmpdir(), "zugfolge-game-symlink-target-"));
    roots.push(root, target);
    await symlink(target, join(root, directory), process.platform === "win32" ? "junction" : "dir");
    const service = new InfraPackageStaging(root, {
      packageVerifier: async () => ({ packageId: "unused", version: "unused", manifestSha256: HASH_A }),
    });
    await expect(service.begin("annual-2026-symlink", { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) }))
      .rejects.toThrow("muss ein regulaeres Verzeichnis sein");
  });

  it("verschiebt kein Paket, wenn der vollständige Game-Prüfer scheitert", async () => {
    const fixture = packageFixture();
    const verifier = vi.fn(async () => { throw new Error("PMTiles-Prüfung fehlgeschlagen"); });
    const service = await staging(verifier);
    const importId = "annual-2026-rejected";
    await service.begin(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) });
    const accepted = await service.uploadManifest(importId, { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) }, chunks(fixture.manifest));
    for (const part of fixture.parts) {
      const partId = accepted.parts.find(({ packagePath }) => packagePath === part.path)!.partId;
      await service.uploadPart(importId, partId, { bytes: part.bytes.length, sha256: sha256(part.bytes) }, chunks(part.bytes));
    }
    await expect(service.finalize(importId)).rejects.toThrow("PMTiles-Prüfung fehlgeschlagen");
    expect(verifier).toHaveBeenCalledOnce();
  });

  it("verwirft beschädigte Paketteile vor der Ablage", async () => {
    const fixture = packageFixture();
    const service = await staging();
    await service.begin("annual-2026-corrupt", { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) });
    const accepted = await service.uploadManifest("annual-2026-corrupt", { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) }, chunks(fixture.manifest));
    await expect(service.uploadPart("annual-2026-corrupt", accepted.parts[0]!.partId, { bytes: accepted.parts[0]!.bytes, sha256: accepted.parts[0]!.sha256 }, chunks(Buffer.from("falsch"))))
      .rejects.toBeInstanceOf(InfraPackageStagingError);
  });

  it("lehnt die abgelöste Rohdaten-Policybezeichnung im strikten Operational-v2-Bericht ausdrücklich ab", async () => {
    const fixture = packageFixture("internalStationPlanRawDataShipped");
    const service = await staging();
    const importId = "annual-2026-legacy-policy";
    const manifestProof = { bytes: fixture.manifest.length, sha256: sha256(fixture.manifest) };
    await service.begin(importId, manifestProof);
    const accepted = await service.uploadManifest(importId, manifestProof, chunks(fixture.manifest));
    for (const part of fixture.parts) {
      const partId = accepted.parts.find(({ packagePath }) => packagePath === part.path)!.partId;
      await service.uploadPart(importId, partId, { bytes: part.bytes.length, sha256: sha256(part.bytes) }, chunks(part.bytes));
    }
    await expect(service.finalize(importId)).rejects.toThrow("Operational-v2-Qualitätsbericht besitzt unerwartete oder fehlende Felder");
  });
});

describe("Infra-Upload-HMAC", () => {
  it("bindet Methode, Pfad, Bytezahl und SHA-256 und lehnt Wiederholungen außerhalb des Zeitfensters ab", () => {
    const key = { id: "odoo-infra-1", secret: "test-secret-with-enough-entropy" };
    const timestamp = "2026-08-12T12:00:00.000Z";
    const signature = infraUploadSignature({ key, timestamp, method: "PUT", pathname: "/upload/part", contentBytes: 7, contentSha256: HASH_A });
    expect(() => verifyInfraUploadSignature({ keyId: key.id, timestamp, signature, method: "PUT", pathname: "/upload/part", contentBytes: 7, contentSha256: HASH_A, keys: [key], now: new Date(timestamp) })).not.toThrow();
    expect(() => verifyInfraUploadSignature({ keyId: key.id, timestamp, signature, method: "PUT", pathname: "/upload/part", contentBytes: 7, contentSha256: HASH_A, keys: [key], now: new Date("2026-08-12T12:06:00.000Z") })).toThrow(/abgelaufen/);
  });
});
